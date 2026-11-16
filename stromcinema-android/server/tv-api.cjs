'use strict';
/**
 * Strøm TV API — everything the Android TV front end needs, in one additive module.
 *
 * Mounted from plexus-server.cjs with a single line (see the bottom of that file's route block):
 *   require('./tv-api.cjs')(app, { getConfig: () => config, saveConfig: () => saveConfig(config),
 *                                   baseDir: __dirname, axios });
 *
 * Routes
 *   GET  /api/tv/library    movies with parsed title/year, case type (uhd | bluray), poster URL, resume point,
 *                           plus the shelf look settings. Poster matching runs in the background; the response
 *                           carries `pending` so the TV can poll again until all covers are in.

 *   GET  /api/tv/shows      TV series (folders marked "TV Shows"): one entry per show with seasons -> episodes,
 *                           cover, and the episode to continue with.
 *   GET  /api/tv/poster/:id poster image (downloaded from TMDB once, then served from disk -> TV works offline)
 *   POST /api/tv/progress   { id, positionMs, durationMs }  (sent by the native player while playing)
 *   GET  /api/tv/settings   shelf look settings
 *   POST /api/tv/settings   { pose, fit, round, speed, sort, language, quality, background, intro }
 *   POST /api/tv/refresh    rescan folders + retry unmatched covers
 *   GET  /api/tv/tracks/:id audio + subtitle tracks of a film/episode (read from the file) and subtitle files next to it
 *   GET  /api/tv/subtitle/:id/:n  a subtitle file that sits next to the film
 *
 * All state lives next to the server in ./data (tv-metadata.json, tv-progress.json, tv-posters/).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tracks = require('./tracks.cjs');

const VIDEO_EXT = ['.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.ts'];
const BG_PRESETS = ['purple', 'blue', 'teal', 'green', 'wine', 'charcoal', 'black'];
const SETTINGS_DEFAULTS = Object.freeze({
  pose: 'fan',        // 'fan' (faces turn to the centre) | 'shelf' (spines towards you) | 'grid' (flat posters, like Plex / Kodi)
  fit: 'fill',        // 'fill' | 'fit' | 'stretch'  – how the poster sits in the case
  round: 1.5,         // top corner radius in px
  speed: 0.65,        // browsing animation speed (0.35 – 1.2)
  sort: 'title',      // 'title' | 'added'
  language: 'sv-SE',  // TMDB language for titles/overviews
  background: 'purple', // preset name or a #rrggbb colour
  intro: 'on',        // start-up intro: 'on' (with sound) | 'silent' | 'off'
  preferredAudio: 'eng',     // 3-letter language code, or 'any'
  preferredSubtitle: 'off',  // 'off' or a 3-letter language code
  quality: 'smooth',  // 'smooth' (lighter 3D, best on TV hardware) | 'full' (all reflections)
  audioConvert: 'auto', // Android TV: convert TrueHD/DTS audio to Dolby Digital. 'auto' (only if the TV cannot play it) | 'on' | 'off'
});

// ─── release-name parsing (port of the cover app's titleParser.js) ────────────
const YEAR = /^(19|20)\d{2}$/;
const JUNK = new RegExp('^(' + [
  '\\d{3,4}[pi]', '4k', 'uhd', 'hd', 'sd',
  'blu-?ray', 'bdrip', 'brrip', 'bdremux', 'remux', 'web-?dl', 'webrip', 'hdtv', 'dvdrip', 'dvdscr', 'hddvd',
  'x26[45]', 'h26[45]', 'hevc', 'avc', 'av1', 'xvid', 'divx',
  '(dd|ddp|eac3|ac3|aac|dts|flac|opus|truehd|atmos)(\\+|\\d)*', 'dts-?(hd|x)',
  'hdr\\d*\\+?', 'dv', 'dovi', 'dolby', '10bit', '8bit', 'sdr', '3d', 'hsbs',
  'proper', 'repack', 'internal', 'swesub', 'nordic', 'dubbed', 'subbed',
].join('|') + ')$', 'i');
const EDITION = /\s+(the\s+)?(final|director'?s|directors|ultimate|extended|theatrical|redux|special|collector'?s|anniversary|unrated|uncut|remastered|restored|imax|criterion)(\s+(cut|edition|version))?(\s.*)?$/i;
const GENERIC = /^(movie|film|video|main|title|sample|stream|feature|\d{1,6})$/i;
const WRAPPER = /^(bdmv|stream|video_ts|certificate|playlist|backup|disc\d*|cd\d|part\d)$/i;

function baseName(fileName) {
  return String(fileName || '').replace(/\.[^./\\]+$/, '');
}

function parseReleaseName(input) {
  let s = baseName(input);
  s = s.replace(/\[(\d{4})\]/g, ' $1 ').replace(/\[[^\]]*\]/g, ' ').replace(/[(){}]/g, ' ');
  s = s.replace(/\bh[. ]?26([45])\b/gi, ' h26$1 ');
  const tokens = s.split(/[._\s]+/).filter(Boolean);
  let junkIdx = tokens.findIndex((t, i) => i > 0 && JUNK.test(t));
  if (junkIdx === -1) junkIdx = tokens.length;
  let yearIdx = -1;
  for (let i = 1; i < junkIdx; i++) if (YEAR.test(tokens[i])) yearIdx = i;
  const year = yearIdx > 0 ? tokens[yearIdx] : '';
  const titleTokens = tokens.slice(0, yearIdx > 0 ? yearIdx : junkIdx);
  const title = titleTokens.join(' ').replace(/\s+/g, ' ').trim() || tokens.join(' ').trim();
  return { title, year };
}

function searchAttempts(input) {
  const { title, year } = parseReleaseName(input);
  const noEdition = title.replace(EDITION, '').trim();
  const list = [];
  if (year) list.push({ query: title, year });
  if (year) list.push({ query: `${title} ${year}` });
  list.push({ query: title });
  if (noEdition && noEdition !== title) {
    if (year) list.push({ query: noEdition, year });
    list.push({ query: noEdition });
  }
  // "S W A T" / "M A S H" (dots turned into spaces) -> also try the letters joined: "SWAT"
  const joined = title.replace(/\b(?:[A-Za-z] ){1,}[A-Za-z]\b/g, (m) => m.replace(/ /g, ''));
  if (joined !== title) { if (year) list.push({ query: joined, year }); list.push({ query: joined }); }
  const seen = new Set();
  return list.filter((a) => { const k = `${a.query}|${a.year || ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// "movie.mkv" / "00000.m2ts" say nothing about the film -> fall back to the folder name.
function releaseNameFor(fullPath, rootDir) {
  const rel = path.relative(rootDir, fullPath);
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const file = baseName(parts.pop() || '');
  const generic = (n) => { const p = parseReleaseName(n); return !p.year && GENERIC.test(p.title.replace(/\s+/g, '')); };
  if (!generic(file)) return file;
  for (let i = parts.length - 1; i >= 0; i--) if (!WRAPPER.test(parts[i]) && !generic(parts[i])) return parts[i] + '.mkv'; // (parseReleaseName strips a file extension, so give folder names one)
  return file;
}

// Which case a file gets (4K UHD = black, everything else = Blu-ray blue) and the small
// badge printed in the case header. Only facts found in the file name are shown.
function caseInfo(relPath) {
  if (/(2160p|\b4k\b|\buhd\b)/i.test(relPath)) {
    if (/dolby[ ._-]?vision|\bdovi\b|\bdv\b/i.test(relPath)) return { type: 'uhd', badge: 'DOLBY VISION' };
    if (/\bhdr(10)?\+?\b/i.test(relPath)) return { type: 'uhd', badge: 'HDR' };
    return { type: 'uhd', badge: '2160p' };
  }
  const res = /(1080|720|576|480)[pi]/i.exec(relPath);
  return { type: 'bluray', badge: res ? `${res[1]}p` : '' };
}

// ─── TV episodes ──────────────────────────────────────────────────────────────
const EP_SXE = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?:[ ._-]?e\d{1,3})*(?![a-z0-9])/i;
const EP_NXN = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![a-z0-9])/i;
const EP_ONLY = /(?:^|[^a-z0-9])e(?:p(?:isode)?)?[ ._-]?(\d{1,3})(?![a-z0-9])/i;
const SEASON_DIR = /^(season|säsong|sasong|series|s)[ ._-]*(\d{1,2})\b/i;

/** Splits "Show.Name.2019.S02E05.Episode.Title.1080p.mkv" (or Show/Season 2/05.mkv) into show / season / episode. */
function parseEpisode(fullPath, rootDir) {
  const parts = path.relative(rootDir, fullPath).split(/[\\/]/).filter(Boolean);
  const file = baseName(parts.pop() || '');
  let season = null, episode = null, cut = -1, afterIdx = 0;
  let m = EP_SXE.exec(file);
  if (m) { season = +m[1]; episode = +m[2]; cut = m.index; afterIdx = m.index + m[0].length; }
  else if ((m = EP_NXN.exec(file))) { season = +m[1]; episode = +m[2]; cut = m.index; afterIdx = m.index + m[0].length; }
  else if ((m = EP_ONLY.exec(file))) { episode = +m[1]; cut = m.index; afterIdx = m.index + m[0].length; }
  const folderSeason = parts.map((x) => SEASON_DIR.exec(x)).filter(Boolean).pop();
  if (season === null) season = folderSeason ? +folderSeason[2] : 1;
  // show name: the folder right under the library folder wins (consistent across releases), else the file name
  const showFolder = parts.find((x) => !SEASON_DIR.test(x));
  let showRaw = showFolder || '';
  // season-pack folders: "Dexter.Resurrection.S01.1080p.AMZN.WEB-DL..." / "Show.2019.S01-S03.COMPLETE" / "Show Season 2" -> keep only the show name (and year)
  showRaw = showRaw.replace(/[ ._-]+(s\d{1,2}(e\d{1,3})?(-?s?\d{1,2})?|seasons?[ ._-]*\d+|complete|säsong[ ._-]*\d+)([ ._-].*)?$/i, '');
  if (!showRaw) showRaw = cut > 0 ? file.slice(0, cut) : file;
  let { title, year } = parseReleaseName(showRaw + '.mkv'); // (a dummy extension keeps "Show.2019" from losing its year)
  if (!title) ({ title, year } = parseReleaseName(file + '.mkv'));
  let epTitle = '';
  if (afterIdx) {
    const rest = file.slice(afterIdx).replace(/\[[^\]]*\]/g, ' ');
    const toks = rest.split(/[._\s]+/).filter(Boolean);
    let j = toks.findIndex((t) => JUNK.test(t) || YEAR.test(t));
    if (j === -1) j = toks.length;
    epTitle = toks.slice(0, j).join(' ').replace(/^[-–]\s*/, '').trim();
  }
  return { show: title, year, season, episode, epTitle };
}

function makeId(fullPath) {
  return 'win-' + crypto.createHash('sha1').update(fullPath).digest('hex').slice(0, 24);
}

module.exports = function mountTvApi(app, ctx) {
  const { getConfig, saveConfig, baseDir } = ctx;
  const axios = ctx.axios || require('axios');
  const TMDB = ctx.tmdbBase || 'https://api.themoviedb.org/3';
  const IMG = ctx.imageBase || 'https://image.tmdb.org/t/p/w780';
  const DATA_DIR = path.join(baseDir, 'data');
  const POSTER_DIR = path.join(DATA_DIR, 'tv-posters');
  const META_FILE = path.join(DATA_DIR, 'tv-metadata.json');
  const PROGRESS_FILE = path.join(DATA_DIR, 'tv-progress.json');

  fs.mkdirSync(POSTER_DIR, { recursive: true });

  const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
  const writeJson = (file, value) => { try { fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); } catch (e) { console.warn('[TV] could not write', path.basename(file), e.message); } };

  let metadata = readJson(META_FILE, {});     // id -> { tmdbId, title, year, overview, posterPath, notFound, checkedAt }
  let progress = readJson(PROGRESS_FILE, {}); // id -> { positionMs, durationMs, updatedAt }
  let progressTimer = null;
  const saveMetadata = () => writeJson(META_FILE, metadata);
  const saveProgressSoon = () => {
    if (progressTimer) return;
    progressTimer = setTimeout(() => { progressTimer = null; writeJson(PROGRESS_FILE, progress); }, 1500);
  };

  // ─── settings (live in plexus-config.json under "tv") ───────────────────────
  function getSettings() {
    const raw = (getConfig().tv) || {};
    const s = { ...SETTINGS_DEFAULTS };
    if (raw.pose === 'fan' || raw.pose === 'shelf' || raw.pose === 'grid') s.pose = raw.pose;
    if (['fill', 'fit', 'stretch'].includes(raw.fit)) s.fit = raw.fit;
    if (Number.isFinite(Number(raw.round))) s.round = Math.max(0, Math.min(12, Number(raw.round)));
    if (Number.isFinite(Number(raw.speed))) s.speed = Math.max(0.35, Math.min(1.2, Number(raw.speed)));
    if (raw.sort === 'title' || raw.sort === 'added') s.sort = raw.sort;
    if (BG_PRESETS.includes(raw.background) || /^#[0-9a-fA-F]{6}$/.test(String(raw.background || ''))) s.background = raw.background;
    if (['on', 'silent', 'off'].includes(raw.intro)) s.intro = raw.intro;
    if (raw.preferredAudio === 'any' || /^[a-z]{3}$/.test(raw.preferredAudio || '')) s.preferredAudio = raw.preferredAudio;
    if (raw.preferredSubtitle === 'off' || /^[a-z]{3}$/.test(raw.preferredSubtitle || '')) s.preferredSubtitle = raw.preferredSubtitle;
    if (raw.quality === 'smooth' || raw.quality === 'full') s.quality = raw.quality;
    if (['auto', 'on', 'off'].includes(raw.audioConvert)) s.audioConvert = raw.audioConvert;
    if (typeof raw.language === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(raw.language)) s.language = raw.language;
    return s;
  }

  // ─── library scan ───────────────────────────────────────────────────────────
  const scanCaches = { movie: { at: 0, files: [] }, tv: { at: 0, files: [] } };
  // A folder's category decides where it shows up: "TV Shows"/"TV series" -> TV, "Movies"/"Film" (or none) -> movies.
  const KIND_RE = { movie: /movie|film/i, tv: /\btv\b|serie|show/i };
  function libraryRoots(kind = 'movie') {
    return (getConfig().libraryPaths || [])
      .map((e) => (typeof e === 'string' ? { path: e, category: 'Movies' } : e))
      .filter((e) => e && e.path && (kind === 'movie' ? (!e.category || KIND_RE.movie.test(e.category)) : (e.category && KIND_RE.tv.test(e.category))))
      .map((e) => path.normalize(e.path));
  }

  function scanLibrary(force, kind = 'movie') {
    const scanCache = scanCaches[kind];
    if (!force && Date.now() - scanCache.at < 60_000) return scanCache.files;
    const files = [];
    const walk = (dir, root) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full, root); continue; }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!VIDEO_EXT.includes(ext)) continue;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (/(^|[^a-z])sample([^a-z]|$)/i.test(entry.name) && st.size < 100 * 1024 * 1024) continue;
        files.push({ full, root, ext, size: st.size, addedAt: st.mtimeMs });
      }
    };
    for (const root of libraryRoots(kind)) {
      if (fs.existsSync(root)) walk(root, root); else console.warn('[TV] library path not found:', root);
    }
    scanCaches[kind] = { at: Date.now(), files };
    return files;
  }

  // ─── TMDB matching (background, 3 at a time, results cached on disk) ────────
  const queue = [];
  const queued = new Set();
  let workers = 0;

  async function tmdbGet(pathname, params) {
    const key = String(getConfig().tmdbApiKey || '').trim();
    const isToken = key.startsWith('eyJ');
    const res = await axios.get(`${TMDB}${pathname}`, {
      params: isToken ? params : { ...params, api_key: key },
      headers: isToken ? { accept: 'application/json', Authorization: `Bearer ${key}` } : undefined,
      timeout: 15000,
    });
    return res.data;
  }

  async function matchOne(item) {
    const language = getSettings().language;
    const isTv = item.kind === 'tv';
    for (const a of searchAttempts(item.rawName)) {
      const params = { query: a.query, include_adult: 'false', language, page: '1' };
      if (a.year) params[isTv ? 'first_air_date_year' : 'year'] = a.year;
      const data = await tmdbGet(isTv ? '/search/tv' : '/search/movie', params);
      if (data && data.results && data.results.length) {
        const { year } = parseReleaseName(item.rawName);
        const date = (r) => (isTv ? r.first_air_date : r.release_date) || '';
        const best = (year && data.results.find((r) => date(r).startsWith(year))) || data.results[0];
        return {
          tmdbId: best.id,
          title: (isTv ? best.name || best.original_name : best.title || best.original_title) || '',
          year: date(best).slice(0, 4),
          overview: (best.overview || '').slice(0, 300),
          posterPath: best.poster_path || '',
          checkedAt: Date.now(),
        };
      }
    }
    return { notFound: true, checkedAt: Date.now(), raw: item.rawName };
  }

  // runtime + genres need a second TMDB call ("details"); done once per title and saved with the cover info
  async function detailsOf(tmdbId, isTv) {
    const language = getSettings().language, lang2 = language.slice(0, 2);
    const base = isTv ? '/tv/' : '/movie/';
    try {
      // one request also brings cast/crew and trailers; videos are asked for in the cover language, English, or language-less
      const d = await tmdbGet(`${base}${tmdbId}`, { language, append_to_response: 'credits,videos', include_video_language: [...new Set([lang2, 'en', 'null'])].join(',') });
      let overview = d.overview || '';
      if (!overview && lang2 !== 'en') { try { overview = (await tmdbGet(`${base}${tmdbId}`, { language: 'en-US' })).overview || ''; } catch { /* keep empty */ } }
      const runtime = isTv ? ((d.episode_run_time || [])[0] || 0) : (d.runtime || 0);
      const crew = (d.credits && d.credits.crew) || [];
      const director = isTv ? (d.created_by || []).map((x) => x.name) : crew.filter((c) => c.job === 'Director').map((c) => c.name);
      const cast = ((d.credits && d.credits.cast) || []).slice(0, 6).map((c) => c.name).filter(Boolean);
      let vids = ((d.videos && d.videos.results) || []).filter((v) => v.site === 'YouTube' && v.key);
      if (!vids.length) {   // nothing in the cover language / English: ask for the film's videos on their own (TMDB default language)
        for (const l of ['en-US', undefined]) {
          try { const v = await tmdbGet(`${base}${tmdbId}/videos`, l ? { language: l } : {}); vids = ((v && v.results) || []).filter((x) => x.site === 'YouTube' && x.key); } catch { /* no videos */ }
          if (vids.length) break;
        }
      }
      const rank = (v) => (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 2 : 4) + (v.official ? 0 : 1) + (v.iso_639_1 === lang2 ? 0 : v.iso_639_1 === 'en' ? 0.5 : 0.8);
      const trailer = vids.length ? vids.slice().sort((x, y) => rank(x) - rank(y))[0].key : '';
      return {
        runtime, genres: (d.genres || []).map((g) => g.name).filter(Boolean).slice(0, 3), detailsAt: Date.now(), detailsV: 3,
        fullOverview: overview.slice(0, 1200), tagline: (d.tagline || '').slice(0, 160), director: director.slice(0, 3), cast,
        rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : 0, trailer,
      };
    } catch (e) {
      if (e.response && e.response.status === 404) return { runtime: 0, genres: [], detailsAt: Date.now(), detailsV: 3 };
      throw e;
    }
  }

  async function pump() {
    if (workers >= 3) return;
    workers++;
    try {
      while (queue.length) {
        const item = queue.shift();
        try {
          const prev = metadata[item.id];
          if (prev && prev.tmdbId) {
            metadata[item.id] = { ...prev, ...(await detailsOf(prev.tmdbId, item.kind === 'tv')) };
          } else {
            const found = await matchOne(item);
            if (found.tmdbId) Object.assign(found, await detailsOf(found.tmdbId, item.kind === 'tv').catch(() => ({})));
            metadata[item.id] = found;
          }
          saveMetadata();
        } catch (e) {
          const status = e.response && e.response.status;
          if (status === 401 || status === 403) {
            console.warn('[TV] TMDB rejected the API key — check it on the setup page. Stopping cover matching.');
            queue.length = 0;
          } else {
            console.warn(`[TV] TMDB lookup failed for "${item.rawName}":`, e.message);
          }
        } finally {
          queued.delete(item.id);
        }
      }
    } finally {
      workers--;
    }
  }

  function enqueueMissing(items, retryNotFound) {
    if (!String(getConfig().tmdbApiKey || '').trim()) return;
    const retryBefore = Date.now() - 24 * 3600 * 1000;
    for (const item of items) {
      const m = metadata[item.id];
      const needs = !m || (m.notFound && m.raw !== item.rawName) || (retryNotFound && m.notFound && (m.checkedAt || 0) < retryBefore) || (m.tmdbId && (m.detailsAt === undefined || m.detailsV !== 3));
      if (needs && !queued.has(item.id)) { queued.add(item.id); queue.push(item); }
    }
    if (queue.length) { pump(); pump(); pump(); }
  }

  // ─── building the library payload ───────────────────────────────────────────
  function buildLibrary(force) {
    const settings = getSettings();
    const files = scanLibrary(force, 'movie');
    const items = files.map((f) => {
      const rawName = releaseNameFor(f.full, f.root);
      const parsed = parseReleaseName(rawName);
      return { id: makeId(f.full), file: f, rawName, parsed };
    });
    enqueueMissing(items, force);

    const hasKey = !!String(getConfig().tmdbApiKey || '').trim();
    const movies = items.map((it) => {
      const m = metadata[it.id] || {};
      const matched = !!m.tmdbId;
      const title = (matched && m.title) || it.parsed.title || it.rawName;
      const year = (matched && m.year) || it.parsed.year || '';
      const p = progress[it.id];
      const dur = p ? Number(p.durationMs) || 0 : 0;
      const pos = p ? Number(p.positionMs) || 0 : 0;
      const finished = dur > 0 && pos >= dur * 0.95;
      const resumeMs = p && pos >= 30_000 && !finished ? Math.round(pos) : 0;
      return {
        id: it.id,
        title,
        year,
        tag: (matched && m.overview) || '',
        runtime: (matched && m.runtime) || 0,
        genres: (matched && m.genres) || [],
        overview: (matched && (m.fullOverview || m.overview)) || '', tagline: (matched && m.tagline) || '', director: (matched && m.director) || [], cast: (matched && m.cast) || [], rating: (matched && m.rating) || 0, trailer: (matched && m.trailer) || '',
        type: caseInfo(path.relative(it.file.root, it.file.full)).type,
        badge: caseInfo(path.relative(it.file.root, it.file.full)).badge,
        poster: matched && m.posterPath ? `/api/tv/poster/${it.id}` : '',
        stream: `/api/stream?path=${encodeURIComponent(it.file.full)}`,
        fileName: path.basename(it.file.full),
        addedAt: it.file.addedAt,
        resumeMs,
        durationMs: dur,
        watched: finished,
      };
    });
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    if (settings.sort === 'added') movies.sort((a, b) => b.addedAt - a.addedAt);
    else movies.sort((a, b) => collator.compare(a.title, b.title));

    const pending = hasKey ? queued.size : 0;
    return { movies, settings, pending, tmdb: hasKey, folders: libraryRoots('movie').length, tvFolders: libraryRoots('tv').length };
  }

  function progressInfo(id) {
    const p = progress[id];
    const dur = p ? Number(p.durationMs) || 0 : 0;
    const pos = p ? Number(p.positionMs) || 0 : 0;
    const finished = dur > 0 && pos >= dur * 0.95;
    return { dur, pos, finished, resumeMs: p && pos >= 30_000 && !finished ? Math.round(pos) : 0, updatedAt: p ? p.updatedAt || 0 : 0 };
  }

  function buildShows(force) {
    const settings = getSettings();
    const files = scanLibrary(force, 'tv');
    const groups = new Map();
    for (const f of files) {
      const info = parseEpisode(f.full, f.root);
      const key = info.show.toLowerCase().replace(/[^a-z0-9åäöæøü]+/g, '');
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { key, title: info.show, year: info.year, files: [] });
      const g = groups.get(key);
      if (!g.year && info.year) g.year = info.year;
      g.files.push({ f, info });
    }
    const showItems = [...groups.values()].map((g) => ({
      id: makeId('show:' + g.key), kind: 'tv', rawName: g.year ? `${g.title} ${g.year}` : g.title, group: g,
    }));
    enqueueMissing(showItems, force);

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const hasKey = !!String(getConfig().tmdbApiKey || '').trim();
    const shows = showItems.map((it) => {
      const g = it.group, m = metadata[it.id] || {}, matched = !!m.tmdbId;
      // order: season, episode, then file name; files without an episode number are numbered in name order
      g.files.sort((a, b) => a.info.season - b.info.season || collator.compare(path.basename(a.f.full), path.basename(b.f.full)));
      const counters = {};
      const eps = g.files.map(({ f, info }) => {
        counters[info.season] = (counters[info.season] || 0) + 1;
        const episode = info.episode !== null ? info.episode : counters[info.season];
        const id = makeId(f.full), pi = progressInfo(id);
        return { id, season: info.season, episode, title: info.epTitle, stream: `/api/stream?path=${encodeURIComponent(f.full)}`,
                 fileName: path.basename(f.full), addedAt: f.addedAt, resumeMs: pi.resumeMs, durationMs: pi.dur, watched: pi.finished, updatedAt: pi.updatedAt, root: f.root, full: f.full };
      });
      eps.sort((a, b) => a.season - b.season || a.episode - b.episode);
      // continue with: the episode you were last in the middle of, else the one after the last finished one, else the first
      let cont = eps[0];
      const touched = eps.filter((e) => e.updatedAt).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (touched) cont = touched.resumeMs > 0 || !touched.watched ? touched : (eps[eps.indexOf(touched) + 1] || touched);
      const seasons = [];
      for (const e of eps) {
        let s = seasons.find((x) => x.season === e.season);
        if (!s) { s = { season: e.season, episodes: [] }; seasons.push(s); }
        s.episodes.push({ id: e.id, season: e.season, episode: e.episode, title: e.title, stream: e.stream, fileName: e.fileName, resumeMs: e.resumeMs, durationMs: e.durationMs, watched: e.watched });
      }
      const ci = caseInfo(path.relative(eps[0].root, eps[0].full));
      return {
        id: it.id,
        title: (matched && m.title) || g.title,
        year: (matched && m.year) || g.year || '',
        tag: (matched && m.overview) || '',
        runtime: (matched && m.runtime) || 0,
        genres: (matched && m.genres) || [],
        overview: (matched && (m.fullOverview || m.overview)) || '', tagline: (matched && m.tagline) || '', director: (matched && m.director) || [], cast: (matched && m.cast) || [], rating: (matched && m.rating) || 0, trailer: (matched && m.trailer) || '',
        type: ci.type, badge: ci.badge,
        poster: matched && m.posterPath ? `/api/tv/poster/${it.id}` : '',
        fileName: path.basename(path.dirname(eps[0].full)),
        addedAt: Math.max(...eps.map((e) => e.addedAt)),
        episodeCount: eps.length,
        watchedCount: eps.filter((e) => e.watched).length,
        continueId: cont.id,
        seasons,
      };
    });
    if (settings.sort === 'added') shows.sort((a, b) => b.addedAt - a.addedAt);
    else shows.sort((a, b) => collator.compare(a.title, b.title));
    return { shows, settings, pending: hasKey ? queued.size : 0, tmdb: hasKey, folders: libraryRoots('tv').length };
  }

  app.get('/api/tv/library', (req, res) => {
    try {
      res.json(buildLibrary(req.query.refresh === '1'));
    } catch (e) {
      console.error('[TV] library failed:', e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/tv/shows', (req, res) => {
    try {
      res.json(buildShows(req.query.refresh === '1'));
    } catch (e) {
      console.error('[TV] shows failed:', e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/tv/refresh', (req, res) => {
    try { buildShows(true); res.json(buildLibrary(true)); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── posters ────────────────────────────────────────────────────────────────
  const posterDownloads = new Map();
  app.get('/api/tv/poster/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^win-[0-9a-f]{24}$/.test(id)) return res.status(400).end();
    const file = path.join(POSTER_DIR, `${id}.jpg`);
    try {
      if (!fs.existsSync(file)) {
        const m = metadata[id];
        if (!m || !m.posterPath) return res.status(404).end();
        if (!posterDownloads.has(id)) {
          const job = axios.get(`${IMG}${m.posterPath}`, { responseType: 'arraybuffer', timeout: 20000 })
            .then((r) => { fs.writeFileSync(file, Buffer.from(r.data)); })
            .finally(() => posterDownloads.delete(id));
          posterDownloads.set(id, job);
        }
        await posterDownloads.get(id);
      }
      res.set('Cache-Control', 'public, max-age=86400');
      res.type('jpeg').sendFile(file);
    } catch (e) {
      console.warn(`[TV] poster ${id} unavailable:`, e.message);
      if (!res.headersSent) res.status(502).end();
    }
  });

  // ─── audio / subtitle tracks ─────────────────────────────────────────────────
  function fileById(id) {
    if (!/^win-[0-9a-f]{24}$/.test(id)) return null;
    for (const kind of ['movie', 'tv']) for (const f of scanLibrary(false, kind)) if (makeId(f.full) === id) return f.full;
    return null;
  }
  app.get('/api/tv/tracks/:id', async (req, res) => {
    const id = String(req.params.id || '');
    const file = fileById(id);
    if (!file) return res.status(404).json({ error: 'unknown film' });
    try {
      const emb = await tracks.readEmbedded(file);
      const ext = tracks.findExternalSubs(file).map((x) => ({ n: x.n, label: x.label, lang: x.lang, langName: x.langName, codec: x.codec, forced: x.forced, mime: x.mime, url: `/api/tv/subtitle/${id}/${x.n}` }));
      res.json({ audio: emb.audio, subs: emb.subs, external: ext });
    } catch (e) {
      console.warn('[TV] could not read tracks:', e.message);
      res.json({ audio: [], subs: [], external: [] });
    }
  });
  app.get('/api/tv/subtitle/:id/:n', (req, res) => {
    const file = fileById(String(req.params.id || ''));
    const item = file && tracks.findExternalSubs(file).find((x) => x.n === Number(req.params.n));
    if (!item) return res.status(404).end();
    res.set('Content-Type', item.mime + '; charset=utf-8').set('Cache-Control', 'no-store');
    res.sendFile(item.full);
  });


  // ─── audio conversion for TVs without TrueHD / DTS support ───────────────────
  const converter = require('./convert.cjs')({ baseDir: ctx.baseDir, getConfig });
  app.get('/api/tv/convert/info', async (req, res) => res.json({ ffmpeg: !!(await converter.ffmpegPath()) }));
  app.post('/api/tv/convert/:id', async (req, res) => {
    const id = String(req.params.id || '');
    const file = fileById(id);
    if (!file) return res.status(404).json({ state: 'error', error: 'unknown film' });
    const track = Number((req.body || {}).track);
    if (!Number.isInteger(track) || track < 0 || track > 40) return res.status(400).json({ state: 'error', error: 'bad track' });
    try {
      const t = await tracks.readEmbedded(file);
      const a = t.audio.find((x) => x.index === track) || t.audio[track];
      res.json(await converter.start({ id, file, track, channels: a && a.channels }));
    } catch (e) { res.status(500).json({ state: 'error', error: e.message }); }
  });
  app.get('/api/tv/convert/:id', (req, res) => res.json(converter.status(String(req.params.id || ''), Number(req.query.track))));
  app.delete('/api/tv/convert/:id', (req, res) => { converter.cancel(String(req.params.id || ''), Number(req.query.track)); res.json({ ok: true }); });
  app.get('/api/tv/converted/:name', (req, res) => {
    const f = converter.fileFor(String(req.params.name || ''));
    if (!f) return res.status(404).end();
    res.set('Cache-Control', 'no-store');
    res.sendFile(f);
  });

  // ─── progress ───────────────────────────────────────────────────────────────
  app.post('/api/tv/progress', (req, res) => {
    const { id, positionMs, durationMs } = req.body || {};
    if (!/^win-[0-9a-f]{24}$/.test(String(id || ''))) return res.status(400).json({ ok: false, error: 'bad id' });
    const pos = Number(positionMs), dur = Number(durationMs);
    if (!Number.isFinite(pos) || pos < 0) return res.status(400).json({ ok: false, error: 'bad position' });
    progress[id] = {
      positionMs: Math.round(pos),
      durationMs: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : ((progress[id] && progress[id].durationMs) || 0),
      updatedAt: Date.now(),
    };
    saveProgressSoon();
    res.json({ ok: true });
  });

  // ─── settings ───────────────────────────────────────────────────────────────
  app.get('/api/tv/settings', (req, res) => res.json(getSettings()));
  app.post('/api/tv/settings', (req, res) => {
    const cfg = getConfig();
    cfg.tv = { ...(cfg.tv || {}), ...(req.body || {}) };
    const clean = getSettings();
    cfg.tv = clean;
    saveConfig();
    res.json(clean);
  });

  console.log('[Plexus] TV API ready (/api/tv/library, /api/tv/shows, /api/tv/poster/:id, /api/tv/progress, /api/tv/settings)');
  return { parseReleaseName, searchAttempts, releaseNameFor, makeId };
};
module.exports.parseReleaseName = parseReleaseName;
module.exports.searchAttempts = searchAttempts;
module.exports.releaseNameFor = releaseNameFor;
module.exports.caseInfo = caseInfo;
module.exports.parseEpisode = parseEpisode;
