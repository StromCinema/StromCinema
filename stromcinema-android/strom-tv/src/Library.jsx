import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { absoluteUrl, baseUrl, fetchLibrary, formatResume } from './api.js';
import { playVideo, isDesktop } from './native.js';
import Episodes from './Episodes.jsx';
import { usePosters } from './posters.js';
import TrackPicker from './TrackPicker.jsx';
import Trailer from './Trailer.jsx';
import LocalSettings, { loadLocalPrefs, saveLocalPrefs } from './LocalSettings.jsx';
import { needsConvert, prepareAudio } from './convert.js';
import { fetchTracks, loadChoices, saveChoices, defaultAudio, defaultSub, audioShort, subShort } from './tracks.js';
import { applyBackground } from './theme.js';
import { useInput } from './input.js';
import DebugLog from './DebugLog.jsx';
import { dlog, setLogHost } from './debug.js';
import { markPlaying, clearPlaying, saveLibCache, loadLibCache } from './session.js';

const TONES = ['teal', 'gold', 'rose', 'blue', 'navy', 'amber', 'violet'];
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

function ExitDialog({ onCancel, onChangeServer, onExit }) {
  const items = [
    { t: 'Cancel', run: onCancel },
    { t: isDesktop ? 'Settings' : 'Change server', run: onChangeServer },
    { t: 'Exit app', run: onExit },
  ];
  const [f, setF] = useState(0);
  useInput((name) => {
    if (name === 'left' || name === 'up') setF((x) => Math.max(0, x - 1));
    else if (name === 'right' || name === 'down') setF((x) => Math.min(items.length - 1, x + 1));
    else if (name === 'enter') items[f].run();
    else if (name === 'back') onCancel();
    return true;
  });
  return (
    <div className="dialog-backdrop">
      <div className="dialog">
        <h2>Leave Strøm?</h2>
        <div className="gate-actions">
          {items.map((it, i) => <button key={it.t} tabIndex={-1} className={`btn ${i === f ? 'is-focus' : ''}`} onClick={it.run}>{it.t}</button>)}
        </div>
      </div>
    </div>
  );
}

const fmtRuntime = (m) => (m > 0 ? (m >= 60 ? `${Math.floor(m / 60)}H ${String(m % 60).padStart(2, '0')}M` : `${m}M`) : '');
const epLabel = (e) => `S${e.season}E${e.episode}`;
const flatEpisodes = (show) => (show ? show.seasons.flatMap((s) => s.episodes) : []);
const continueEpisode = (show) => { const all = flatEpisodes(show); return all.find((e) => e.id === show.continueId) || all[0]; };

export default function Library({ host, onChangeServer, onLostServer, onExit }) {
  // the last library the server sent is kept on the device: the shelf shows at once after an app restart while the fresh list loads
  const [boot] = useState(() => { const c = loadLibCache(); return c && c.host === host ? c : null; });
  const [clockTime, setClockTime] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setClockTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [movies, setMovies] = useState(boot ? boot.m : null);     // /api/tv/library payload
  const [tv, setTv] = useState(boot ? boot.t : null);             // /api/tv/shows payload (null = server too old / failed)
  const [debugOpen, setDebugOpen] = useState(false);
  const [error, setError] = useState(null);
  const [category, setCategory] = useState(lsGet('strom_category') === 'tv' ? 'tv' : 'movies');
  const [selected, setSelected] = useState(0);
  const [zone, setZone] = useState('shelf');     // tabs | shelf | actions
  const [action, setAction] = useState(0);
  const [dialog, setDialog] = useState(false);
  const [episodesOf, setEpisodesOf] = useState(null); // show id while the episode list is open
  const [playing, setPlaying] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);   // grid layout: OK on a poster opens Play / Info / Audio / Subtitles
  const [flipped, setFlipped] = useState(false); // the centre case is turned round to show its info
  const [trailerNote, setTrailerNote] = useState(false);   // 'No trailer available' flash
  const [trailerOpen, setTrailerOpen] = useState(false);
  const infoRef = useRef(null);
  const [prep, setPrep] = useState(null);       // { pct } while the server converts the audio for this TV
  const prepCancel = useRef(false);
  const [picker, setPicker] = useState(null);     // 'audio' | 'subs' while a track list is open
  const [trk, setTrk] = useState(null);           // { id, data } tracks of the film under the cursor
  const [choices, setChoices] = useState(loadChoices); // what the viewer picked per film: { a: audio index, s: 'off' | {k:'emb'|'ext', ...} }
  const [caseW, setCaseW] = useState(300);
  const wanted = useRef({ movies: lsGet('strom_sel_movies'), tv: lsGet('strom_sel_tv') });
  const alive = useRef(true);

  useEffect(() => {
    setLogHost(host);
    dlog('library', boot ? `shelf shown from the saved copy (${Math.round((Date.now() - boot.at) / 1000)} s old, ${boot.m.movies ? boot.m.movies.length : 0} films)` : 'no saved copy: waiting for the server');
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (refresh = false) => {
    const t0 = performance.now();
    try {
      const [m, t] = await Promise.all([
        fetchLibrary(host, { refresh }),
        fetchLibrary(host, { refresh, kind: 'tv' }).catch(() => null),
      ]);
      if (!alive.current) return;
      setMovies(m); setTv(t); setError(null);
      saveLibCache(host, m, t);
      dlog('library', `loaded from server in ${Math.round(performance.now() - t0)} ms (${m.movies ? m.movies.length : 0} films, ${t && t.shows ? t.shows.length : 0} shows${refresh ? ', refresh' : ''})`);
    } catch (e) {
      if (alive.current) { setError(e); dlog('library', `server error: ${e && e.message ? e.message : e}`); }
    }
  }, [host]);

  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; }; }, [load]);

  // keep polling while covers are still being matched, or while the server is unreachable
  const pending = Math.max(movies ? movies.pending : 0, tv ? tv.pending : 0);
  useEffect(() => {
    if (!(pending > 0 || error)) return undefined;
    const t = setInterval(() => load(), error ? 5000 : 4000);
    return () => clearInterval(t);
  }, [pending, error, load]);

  const isTv = category === 'tv';
  const payload = isTv ? tv : movies;
  // this device's own view choices (gear icon) win over the server's; "Server default" = nothing stored
  const [local, setLocal] = useState(loadLocalPrefs);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const serverSettings = (movies && movies.settings) || { pose: 'fan', fit: 'fill', round: 1.5, speed: 0.65 };
  const settings = { ...serverSettings, ...local };
  const setPref = (k, v) => setLocal((p) => { const n = { ...p }; if (v === undefined) delete n[k]; else n[k] = v; saveLocalPrefs(n); return n; });
  const resetPrefs = () => { saveLocalPrefs({}); setLocal({}); };
  const items = useMemo(() => {
    const list = payload ? (isTv ? payload.shows : payload.movies) : [];
    if (local.sort && local.sort !== serverSettings.sort) {
      const col = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      return local.sort === 'added' ? [...list].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)) : [...list].sort((a, b) => col.compare(a.title, b.title));
    }
    return list;
  }, [payload, isTv, local.sort, serverSettings.sort]);   // eslint-disable-line react-hooks/exhaustive-deps
  const smooth = settings.quality !== 'full';
  const gridMode = settings.pose === 'grid';   // flat poster grid instead of the 3D cases
  useEffect(() => { if (settings.background) applyBackground(settings.background); }, [settings.background]);
  useEffect(() => { if (settings.intro) { try { localStorage.setItem('strom_intro', settings.intro); } catch { /* ignore */ } } }, [settings.intro]);   // smooth = lighter 3D (fewer layers), the default on TV hardware

  // restore the previously selected title per category (and keep the selection on the same title when the list updates)
  const idsRef = useRef('');
  useEffect(() => {
    const key = category + ':' + items.map((m) => m.id).join('|');
    if (key === idsRef.current) return;
    idsRef.current = key;
    if (!items.length) { setSelected(0); return; }
    const i = items.findIndex((m) => m.id === wanted.current[category]);
    setSelected(i >= 0 ? i : 0);
  }, [items, category]);

  const current = items[Math.min(selected, Math.max(0, items.length - 1))];
  useEffect(() => {
    if (current) { wanted.current[category] = current.id; lsSet('strom_sel_' + category, current.id); }
  }, [current, category]);
  const switchCategory = (c) => { if (c === category) return; dlog('ui', `tab -> ${c}`); setCategory(c); lsSet('strom_category', c); setZone('tabs'); setAction(0); };

  useEffect(() => { setFlipped(false); setTrailerNote(false); setTrailerOpen(false); setActionsOpen(false); }, [selected, category]);

  // poster grid: how many posters fit in a row (the D-pad needs it for up / down) and keeping the selected one in view
  const [cols, setCols] = useState(7);
  const gridRef = useRef(null);
  const selRef = useRef(null);
  useEffect(() => {
    if (!gridMode) return undefined;
    const calc = () => {
      const el = gridRef.current; if (!el) return;
      const n = Math.max(4, Math.min(10, Math.round(el.clientWidth / (0.115 * window.innerWidth))));   // ~8 posters across, whatever the screen size
      setCols((c) => (c === n ? c : n));
    };
    calc(); window.addEventListener('resize', calc);
    return () => window.removeEventListener('resize', calc);
  }, [gridMode, !!movies, category]);   // eslint-disable-line react-hooks/exhaustive-deps
  // scroll the grid in whole rows, so a row is never cut off under the tabs and the gap above the first visible row stays the same
  useEffect(() => {
    const wrap = gridRef.current, el = selRef.current;
    if (!gridMode || !wrap || !el) return;
    const cards = wrap.querySelectorAll('.pcard');
    const grid = wrap.firstElementChild;
    const pad = parseFloat(getComputedStyle(grid).paddingTop) || 24;
    const rowTop = (r) => (cards[Math.min(cards.length - 1, r * cols)] || el).offsetTop;
    const r = Math.floor(selected / cols);
    const top = rowTop(r), bottom = top + el.offsetHeight;
    let target = null;
    if (top - pad < wrap.scrollTop) target = Math.max(0, top - pad);
    else if (bottom + pad * 0.6 > wrap.scrollTop + wrap.clientHeight) {
      const need = bottom + pad * 0.6 - wrap.clientHeight;
      let rr = 0; while (rr < r && rowTop(rr) - pad < need) rr++;   // first row that starts below what has to scroll away
      target = Math.max(0, rowTop(rr) - pad);
    }
    if (target !== null) wrap.scrollTo({ top: target, behavior: 'smooth' });
  }, [selected, gridMode, cols, category, items.length]);

  const move = useCallback((d) => setSelected((i) => Math.max(0, Math.min(items.length - 1, i + d))), [items.length]);

  // one place that starts playback for a movie or an episode
  const playItem = useCallback(async (target, fromStart, title) => {
    if (!target || playing) return;
    setPlaying(true);
    setActionsOpen(false);
    try {
      const c = choices[target.id] || {};
      const trackOpts = { preferredAudio: settings.preferredAudio || 'any', preferredSubtitle: settings.preferredSubtitle || 'off' };
      if (typeof c.a === 'number') trackOpts.audioIndex = c.a;
      if (c.s === 'off') trackOpts.subtitleOff = true;
      else if (c.s && c.s.k === 'emb') trackOpts.subtitleIndex = c.s.i;
      else if (c.s && c.s.k === 'ext') Object.assign(trackOpts, { subUrl: absoluteUrl(host, c.s.url), subMime: c.s.mime, subLang: c.s.lang, subEmbCount: c.s.embCount || 0 });
      let playUrl = absoluteUrl(host, target.stream);
      // TV can't play this audio (TrueHD / DTS-HD)? let the server make a copy with Dolby Digital audio first
      if (!isDesktop && settings.audioConvert !== 'off') {
        const data = await fetchTracks(host, target.id);
        const tr = data && (typeof c.a === 'number' ? data.audio.find((x) => x.index === c.a) : defaultAudio(data, settings.preferredAudio));
        if (tr && (await needsConvert(tr, settings.audioConvert || 'auto'))) {
          prepCancel.current = false;
          setPrep({ pct: 0 });
          const conv = await prepareAudio({ host, id: target.id, track: tr.index, onProgress: (p) => setPrep({ pct: p }), cancelled: () => prepCancel.current });
          setPrep(null);
          if (prepCancel.current) { setPlaying(false); return; }
          if (conv) { playUrl = absoluteUrl(host, conv); trackOpts.audioIndex = 0; }   // the copy holds just this one audio track
        }
      }
      markPlaying();
      dlog('player', `start: ${title}`);
      const res = await playVideo({
        url: playUrl, title,
        startTimeMs: fromStart ? 0 : target.resumeMs || 0,
        movieId: target.id, progressUrl: `${baseUrl(host)}/api/tv/progress`, ...trackOpts,
      });
      const pos = (res && res.positionMs) || 0, dur = (res && res.durationMs) || 0;
      clearPlaying();
      dlog('player', `closed, app was NOT restarted (position ${Math.round(pos / 1000)} s)`);
      const resumeMs = pos >= 30000 && (!dur || pos < dur * 0.95) ? pos : 0;
      const upd = (x) => (x.id === target.id ? { ...x, resumeMs, durationMs: dur || x.durationMs } : x);
      setMovies((d) => d && { ...d, movies: d.movies.map(upd) });
      setTv((d) => d && { ...d, shows: d.shows.map((sh) => ({ ...sh, seasons: sh.seasons.map((se) => ({ ...se, episodes: se.episodes.map(upd) })) })) });
      setTimeout(() => alive.current && load(), 1000);
    } catch { dlog('player', 'closed or failed to start'); /* nothing to do */ }
    clearPlaying();
    setPlaying(false);
    setAction(0);
  }, [playing, host, load, choices, settings]);

  const playEpisode = useCallback((show, ep, fromStart) => playItem(ep, fromStart, `${show.title} · ${epLabel(ep)}${ep.title ? ` · ${ep.title}` : ''}`), [playItem]);

  // the buttons under the title (also drives the D-pad)
  // the film (or the episode to continue with) whose audio / subtitle tracks the two extra buttons are about
  const trackTarget = current ? (isTv ? continueEpisode(current) : current) : null;
  const trackId = trackTarget ? trackTarget.id : '';
  useEffect(() => {
    setTrk(null); setPicker(null);
    if (!trackId) return undefined;
    let dead = false;
    const t = setTimeout(async () => { const d = await fetchTracks(host, trackId); if (!dead) setTrk({ id: trackId, data: d }); }, 250);
    return () => { dead = true; clearTimeout(t); };
  }, [host, trackId]);
  const trackData = trk && trk.id === trackId ? trk.data : null;
  const choice = choices[trackId] || {};
  const setChoice = (patch) => setChoices((all) => { const n = { ...all, [trackId]: { ...all[trackId], ...patch } }; saveChoices(n); return n; });
  const curAudio = trackData && (typeof choice.a === 'number' ? trackData.audio.find((x) => x.index === choice.a) : defaultAudio(trackData, settings.preferredAudio));
  const curSub = !trackData ? null : choice.s === 'off' ? null : choice.s ? choice.s : defaultSub(trackData, settings.preferredSubtitle);
  const subText = !curSub ? 'Off' : curSub.k === 'emb' ? subShort(trackData.subs.find((x) => x.index === curSub.i) || {}) : subShort(trackData.external.find((x) => x.url === curSub.url) || {});

  const buttons = useMemo(() => {
    if (!current) return [];
    let list;
    if (isTv) {
      const ep = continueEpisode(current);
      if (!ep) return [];
      list = [
        { text: ep.resumeMs > 0 ? `Resume ${epLabel(ep)} · ${formatResume(ep.resumeMs)}` : `Play ${epLabel(ep)}`, primary: true, run: () => playEpisode(current, ep, false) },
        { text: 'Episodes', run: () => setEpisodesOf(current.id) },
      ];
    } else {
      list = [{ text: current.resumeMs > 0 ? `Resume ${formatResume(current.resumeMs)}` : 'Play', primary: true, run: () => playItem(current, false, current.title) }];
      if (current.resumeMs > 0) list.push({ text: 'Start over', run: () => playItem(current, true, current.title) });
    }
    list.push({ text: 'Info', keep: true, run: () => setFlipped(true) });
    if (trackData) {
      if (trackData.audio.length > 1) list.push({ text: `Audio · ${curAudio ? audioShort(curAudio) : 'Auto'}`, keep: true, run: () => setPicker('audio') });
      if (trackData.subs.length + trackData.external.length > 0) list.push({ text: `Subtitles · ${subText}`, keep: true, run: () => setPicker('subs') });
    }
    return list;
  }, [current, isTv, playItem, playEpisode, trackData, curAudio, subText]);

  // covers of the OTHER tab (around the title that was last selected there) stay loaded, so switching tabs is instant
  const otherCovers = useMemo(() => {
    const oc = isTv ? 'movies' : 'tv';
    const list = isTv ? (movies ? movies.movies : []) : (tv ? tv.shows : []);
    const at = Math.max(0, list.findIndex((m) => m.id === wanted.current[oc]));
    const out = [];
    for (let d = 0; d <= 10; d++) for (const i of d === 0 ? [at] : [at - d, at + d]) { const it = list[i]; if (it && it.poster && !out.includes(it.poster)) out.push(it.poster); }
    return out;
  }, [isTv, movies, tv]);   // eslint-disable-line react-hooks/exhaustive-deps
  const posterUrl = usePosters(host, items, Math.min(selected, Math.max(0, items.length - 1)), gridMode ? cols * 4 : 8, otherCovers);
  const z = zone === 'gear' ? 'gear' : (items.length ? zone : 'tabs');
  useInput((name) => {
    if (prep) { if (name === 'back') prepCancel.current = true; return true; }
    if (flipped && !playing && !dialog && !picker) {
      if (name === 'back' || name === 'left' || name === 'right') {
        setFlipped(false); setTrailerNote(false);
        if (name === 'left') setTimeout(() => move(-1), 120); else if (name === 'right') setTimeout(() => move(1), 120);
      } else if (name === 'up' || name === 'down') {
        if (infoRef.current) infoRef.current.scrollBy({ top: name === 'down' ? 70 : -70, behavior: 'smooth' });
      } else if (name === 'enter') {
        if (current && current.trailer) setTrailerOpen(true);
        else { setTrailerNote(true); setTimeout(() => setTrailerNote(false), 2200); }
      }
      return true;
    }
    if (gridMode && actionsOpen && !playing && !dialog && !picker) {
      if (name === 'left') setAction((a) => Math.max(0, a - 1));
      else if (name === 'right') setAction((a) => Math.min(buttons.length - 1, a + 1));
      else if (name === 'up' || name === 'down') {
        // the buttons wrap onto several rows: Up / Down jump to the nearest button in the row above / below
        const els = [...document.querySelectorAll('.ga-actions .btn')].map((e) => e.getBoundingClientRect());
        const cur = els[action];
        if (cur) {
          const cx = cur.left + cur.width / 2, dir = name === 'down' ? 1 : -1;
          let best = -1, bestRow = Infinity, bestDx = Infinity;
          els.forEach((r, i) => {
            const dy = (r.top - cur.top) * dir;
            if (dy < cur.height / 2) return;                       // not in a row above / below
            const dx = Math.abs(r.left + r.width / 2 - cx);
            if (dy < bestRow - 2 || (Math.abs(dy - bestRow) <= 2 && dx < bestDx)) { best = i; bestRow = dy; bestDx = dx; }
          });
          if (best >= 0) setAction(best);
        }
      } else if (name === 'enter' || name === 'playpause') {
        const b = name === 'playpause' ? buttons[0] : buttons[action];
        if (b) { if (!b.keep) setActionsOpen(false); b.run(); }
      } else if (name === 'back') { setActionsOpen(false); setAction(0); }
      return true;
    }
    if (playing) return true;
    if (dialog) return false;
    if (error && !movies) {
      if (name === 'enter') load(true);
      else if (name === 'back') setDialog(true);
      return true;
    }
    if (z === 'gear') {
      if (name === 'left' || name === 'back') setZone('tabs');
      else if (name === 'enter') setSettingsOpen(true);
      else if (name === 'down' && items.length) setZone('shelf');
      else return name === 'up' || name === 'right';
      return true;
    }
    if (z === 'tabs') {
      if (name === 'left') switchCategory('movies');
      else if (name === 'right') { if (category === 'tv') setZone('gear'); else switchCategory('tv'); }
      else if (name === 'down' || (name === 'enter' && items.length)) { if (items.length) setZone('shelf'); }
      else if (name === 'enter') load(true);
      else if (name === 'back') { if (items.length) setZone('shelf'); else setDialog(true); }
      else return false;
      return true;
    }
    switch (name) {
      case 'left':
        if (z === 'actions' && buttons.length > 1) setAction((a) => Math.max(0, a - 1)); else move(-1);
        return true;
      case 'right':
        if (z === 'actions' && buttons.length > 1) setAction((a) => Math.min(buttons.length - 1, a + 1)); else move(1);
        return true;
      case 'down':
        if (z === 'shelf' && gridMode) {
          const lastRow = Math.floor((items.length - 1) / cols) * cols;
          if (selected < lastRow) setSelected(Math.min(items.length - 1, selected + cols));
          // last row: nothing below - the choices open with OK
        } else if (z === 'shelf' && buttons.length) setZone('actions');
        return true;
      case 'up':
        if (z === 'actions') { setZone('shelf'); setAction(0); }
        else if (gridMode && z === 'shelf' && selected >= cols) move(-cols);
        else setZone('tabs');
        return true;
      case 'enter':
        if (z === 'shelf' && gridMode) { setAction(0); setActionsOpen(true); }
        else if (z === 'shelf') { if (isTv) setEpisodesOf(current.id); else buttons[0] && buttons[0].run(); }
        else if (buttons[action]) buttons[action].run();
        return true;
      case 'playpause': if (buttons[0]) buttons[0].run(); return true;
      case 'back':
        if (z === 'actions') { setZone('shelf'); setAction(0); } else setDialog(true);
        return true;
      default: return false;
    }
  });

  // case width drives the corner geometry (same maths as the web prototype)
  useEffect(() => {
    const m = () => { const el = document.querySelector('.shelf .case'); if (el && el.offsetWidth && Math.abs(el.offsetWidth - caseW) > 0.5) setCaseW(el.offsetWidth); };
    m(); window.addEventListener('resize', m); return () => window.removeEventListener('resize', m);
  });

  const rounding = (settings.round || 0) * (caseW / 300);
  const cornerVars = useMemo(() => {
    const R = rounding, b = caseW * 0.1037 * 0.13;
    if (R < 0.4) return { '--arc-rx': '0px', '--arc-ry': '0px' };
    if (R <= b) {
      const u = ((R / b) * 100).toFixed(2);
      return { '--arc-rx': '0px', '--arc-ry': '0px', '--bev-f': `polygon(0 ${R}px,${u}% 0,100% 0,100% 100%,0 100%)`, '--bev-b': `polygon(0 100%,${(100 - u).toFixed(2)}% 0,100% 0,100% ${R}px,0 100%)` };
    }
    const yb = R - Math.sqrt(R * R - (R - b) * (R - b));
    return { '--arc-rx': `${(R - b).toFixed(3)}px`, '--arc-ry': `${yb.toFixed(3)}px`, '--bev-f': `polygon(0 ${R}px,100% ${yb.toFixed(3)}px,100% 100%,0 100%)`, '--bev-b': `polygon(0 ${yb.toFixed(3)}px,100% ${R}px,100% 100%,0 100%)` };
  }, [rounding, caseW]);

  const cornerStrips = useMemo(() => {
    const R = rounding; if (R < 0.4 || (smooth && R < 6)) return []; // tiny corner arcs are invisible, and each one is an extra layer
    const N = R < 3 ? 3 : R < 7 ? 5 : 7, step = Math.PI / 2 / N, out = [];
    for (const side of ['l', 'r']) {
      for (let i = 0; i < N; i++) {
        const base = side === 'l' ? Math.PI : Math.PI * 1.5, tm = base + (i + 0.5) * step;
        const chord = 2 * R * Math.sin(step / 2) + 0.6;
        const dx = R * Math.cos(tm), dy = R + R * Math.sin(tm);
        const k = side === 'l' ? i / (N - 1 || 1) : 1 - i / (N - 1 || 1);
        const left = side === 'l' ? `${(R + dx - chord / 2).toFixed(3)}px` : `calc(var(--w) - ${(R - dx + chord / 2).toFixed(3)}px)`;
        out.push({ key: side + i, style: {
          left,
          top: side === 'l' ? `calc((var(--d) - 2 * var(--b)) / -2 + ${dy.toFixed(3)}px)` : `calc(var(--d) / -2 + ${dy.toFixed(3)}px)`,
          height: side === 'l' ? 'calc(var(--d) - 2 * var(--b))' : undefined,
          width: `${chord.toFixed(3)}px`, '--k': k.toFixed(3),
          transform: `rotateZ(${(((tm * 180) / Math.PI + 90) % 360).toFixed(3)}deg) rotateX(90deg)`,
        } });
      }
    }
    return out;
  }, [rounding, smooth]);

  /* ------------------------------ screens ------------------------------ */
  if (!movies) {
    return (
      <main className="gate">
        <div className="gate-brand"><span className="brand-mark">S</span><span>STRØM</span></div>
        <section className="gate-card">
          {error ? (
            <>
              <h1>{error.kind === 'old-server' ? 'Server needs an update' : 'Connection lost'}</h1>
              <p className="gate-note">{error.message}</p>
              <div className="gate-actions"><button tabIndex={-1} className="btn is-focus" onClick={() => load(true)}>Try again</button></div>
              <p className="gate-note dim">Press Back for more options.</p>
            </>
          ) : (
            <><h1>Loading library…</h1><div className="bar indeterminate"><i /></div></>
          )}
        </section>
        {dialog && <ExitDialog onCancel={() => setDialog(false)} onChangeServer={onChangeServer} onExit={onExit} />}
      </main>
    );
  }

  const posterStyle = (m) => { const u = posterUrl(m.poster); return u ? { backgroundImage: `url(${u})` } : {}; };
  const pose = settings.pose === 'shelf' ? 'shelf' : 'fan';
  const typeLabel = current && current.type === 'uhd' ? '4K ULTRA HD' : 'BLU-RAY';
  const seasonsN = current && isTv ? current.seasons.length : 0;
  const showOpen = isTv && episodesOf ? (tv && tv.shows.find((x) => x.id === episodesOf)) : null;

  let emptyMsg = null;
  if (!items.length) {
    if (isTv && !tv) emptyMsg = ['TV series are not available', 'The server is too old for TV series. Install the newest tv-api.cjs and restart it.'];
    else if (payload && !payload.folders) emptyMsg = [isTv ? 'No TV folders yet' : 'No movie folders yet', isDesktop ? `Press Back, then choose Settings, to add a folder and mark it as ${isTv ? 'TV series' : 'Movies'}.` : `Open http://${host}/setup on a computer, add a folder and mark it as ${isTv ? 'TV series' : 'Movies'}.`];
    else emptyMsg = [isTv ? 'No TV series found' : 'No movies found', 'The folders on the server contain no video files yet. Press OK to scan again.'];
  }

  return (
    <main className="app" style={{ '--round': `${rounding}px`, '--speed': `${1 / (settings.speed || 0.65)}s`, ...cornerVars }}>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">S</span><span>STRØM</span></div>
        <nav className="tabs" aria-label="Category">
          {[['movies', 'Movies'], ['tv', 'TV series']].map(([id, label]) => (
            <button key={id} tabIndex={-1} className={`tab ${category === id ? 'active' : ''} ${z === 'tabs' && category === id ? 'is-focus' : ''}`}
              onClick={() => switchCategory(id)}>{label}</button>
          ))}
        </nav>
        <div className="top-right">
          <time className="clock" aria-label="Current local time">{clockTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time>
          {pending > 0 && <span className="pill"><span className="status-dot" />Fetching covers… {pending} left</span>}
          {error && <span className="pill warn">Connection lost – retrying…</span>}
          {items.length > 0 && <span className="count">{Math.min(selected, items.length - 1) + 1} <i>/</i> {items.length}</span>}
          <button type="button" tabIndex={-1} className={`gear ${z === 'gear' ? 'is-focus' : ''}`} aria-label="View settings" onClick={() => setSettingsOpen(true)}>
            <svg viewBox="0 0 24 24" width="1.25em" height="1.25em" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.7 7.7 0 0 0 0-2l2-1.6a.5.5 0 0 0 .1-.6l-1.9-3.3a.5.5 0 0 0-.6-.2l-2.4 1a7.4 7.4 0 0 0-1.7-1l-.4-2.5a.5.5 0 0 0-.5-.4h-3.8a.5.5 0 0 0-.5.4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1a.5.5 0 0 0-.6.2L2.5 8.8a.5.5 0 0 0 .1.6l2 1.6a7.7 7.7 0 0 0 0 2l-2 1.6a.5.5 0 0 0-.1.6l1.9 3.3c.1.2.4.3.6.2l2.4-1c.5.4 1.1.7 1.7 1l.4 2.5c0 .2.2.4.5.4h3.8c.3 0 .5-.2.5-.4l.4-2.5c.6-.3 1.2-.6 1.7-1l2.4 1c.2.1.5 0 .6-.2l1.9-3.3a.5.5 0 0 0-.1-.6zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" /></svg>
          </button>
        </div>
      </header>

      {emptyMsg ? (
        <section className="empty"><h1>{emptyMsg[0]}</h1><p>{emptyMsg[1]}</p></section>
      ) : (
        <>
          {gridMode ? (
            <section className="pgrid-wrap" ref={gridRef}>
              <div className="pgrid" style={{ '--cols': cols }}>
                {items.map((m, i) => {
                  const sel = i === selected, u = posterUrl(m.poster);
                  const pct = isTv ? (m.episodeCount ? m.watchedCount / m.episodeCount : 0) : (m.durationMs && m.resumeMs ? m.resumeMs / m.durationMs : 0);
                  const done = isTv ? pct >= 1 : !!m.watched;
                  return (
                    <button key={m.id} ref={sel ? selRef : null} tabIndex={-1} aria-label={m.title}
                      className={`pcard ${sel ? 'sel' : ''} ${sel && z === 'shelf' ? 'is-focus' : ''}`}
                      onClick={() => (sel ? (setAction(0), setActionsOpen(true)) : setSelected(i))}>
                      <span className={`pposter ${u ? 'has-poster' : ''}`} style={u ? { backgroundImage: `url(${u})` } : undefined}>
                        {!u && <span className="pfallback">{m.title}</span>}
                        {m.type === 'uhd' && <i className="pchip">4K</i>}
                        {done && <i className="ptick">✓</i>}
                        {!done && pct > 0 && <i className="pbar"><b style={{ width: `${Math.round(Math.min(1, pct) * 100)}%` }} /></i>}
                      </span>
                      <span className="ptitle">{m.title}</span>
                      <span className="pyear">{m.year || ''}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : (
          <section className="stage">
            <i className="edge-fade l" aria-hidden="true" /><i className="edge-fade r" aria-hidden="true" />
            <div className="shelf" data-pose={pose} data-fit={settings.fit || 'fill'} data-quality={smooth ? 'smooth' : 'full'}>
          {items.map((m, i) => {
              const offset = i - selected;
              if (Math.abs(offset) > (smooth ? 5 : 6)) return null; // one extra ring is kept mounted off-screen, hidden by the edge fade, so cases slide in/out instead of popping
              const isCenter = offset === 0;
              const type = m.type === 'uhd' ? 'uhd' : 'bluray';
              const dir = Math.sign(offset);
              const spineInner = <>
                <span className="sp-top">{type === 'uhd' ? <><b>4K</b><i>ULTRA HD</i></> : <b>BLU-RAY</b>}</span>
                <span className="sp-title"><span>{m.title}</span></span>
                <span className="sp-foot">{m.year && <i>{m.year}</i>}</span>
              </>;
              const frontInner = <>
                <span className="case-header">{type === 'uhd' ? <><b>4K</b><span>ULTRA HD</span></> : <b>BLU-RAY</b>}{m.badge && <small>{m.badge}</small>}</span>
                <span className={`poster-art ${posterUrl(m.poster) ? 'has-poster' : ''}`} style={posterStyle(m)}>
                  {!posterUrl(m.poster) && <><i className="orb" /><i className="shape" /><span className="art-lines" /><span className="art-title">{m.title}</span><span className="art-tag">{m.fileName || m.tag}</span>{m.year && <span className="art-footer"><span>{m.year}</span></span>}</>}
                </span>
                <span className="case-bottom" /><i className="gloss" aria-hidden="true" />
              </>;
              const showSpine = pose === 'shelf' || offset < 0; // the side of a case that faces you
              const rOn = smooth ? offset === 0 : Math.abs(offset) <= 2; // smooth: only the centre case is reflected
              const rSpine = !smooth && rOn && offset !== 0 && (pose === 'shelf' || offset < 0);
              const rEdge = !smooth && rOn && pose === 'fan' && offset > 0;
              return (
                <button key={m.id} tabIndex={-1} className={`case ${type} tone-${TONES[i % 7]} ${isCenter ? 'center' : ''} ${isCenter && flipped ? 'flipped' : ''}`}
                  style={{ '--flip': isCenter && flipped ? 1 : 0, '--offset': offset, '--depth': Math.abs(offset), '--dir': dir, '--side': Math.abs(dir) }}
                  onClick={() => (isCenter ? (isTv ? setEpisodesOf(m.id) : buttons[0] && buttons[0].run()) : setSelected(i))} aria-label={m.title}>
                  {(!smooth || isCenter) && <span className="floor" aria-hidden="true" />}
                  {!smooth && <span className="face f-back" aria-hidden="true" />}
                  {(!smooth || isCenter || (pose === 'fan' && offset > 0)) && <span className="face f-edge" aria-hidden="true" />}
                  {(!smooth || isCenter) && <span className="face f-top" aria-hidden="true" />}
                  {(!smooth || isCenter) && cornerStrips.map((c) => <span key={c.key} className="face f-arc" style={c.style} aria-hidden="true" />)}
                  {!smooth && <span className="face f-bottom" aria-hidden="true" />}
                  {(!smooth || isCenter) && <span className="face f-bevel-b" aria-hidden="true" />}
                  {(!smooth || isCenter || showSpine) && <span className="face f-bevel-f" aria-hidden="true" />}
                  {(!smooth || isCenter || showSpine) && <span className="face f-spine" aria-hidden="true">{spineInner}</span>}
                  {isCenter && (
                    <span className="face f-info" aria-hidden="true">
                      <span className="in-card">
                        <span className="in-scroll" ref={infoRef}>
                          <b className="in-title">{m.title}</b>
                          <span className="in-meta">{[m.year, m.runtime > 0 ? fmtRuntime(m.runtime) : '', m.rating > 0 ? `★ ${m.rating.toFixed(1)}` : ''].filter(Boolean).join('  ·  ')}</span>
                          {m.tagline ? <i className="in-tagline">“{m.tagline}”</i> : null}
                          <span className="in-h">SYNOPSIS</span>
                          <span className="in-text">{m.overview || m.tag || 'No synopsis available.'}</span>
                          {m.director && m.director.length ? <><span className="in-h">{isTv ? 'CREATED BY' : 'DIRECTED BY'}</span><span className="in-text">{m.director.join(', ')}</span></> : null}
                          {m.cast && m.cast.length ? <><span className="in-h">STARRING</span><span className="in-text">{m.cast.join(', ')}</span></> : null}
                        </span>
                        <span className={`in-trailer ${flipped ? 'is-focus' : ''}`}>{!m.trailer || trailerNote ? 'No trailer available' : '▶  Watch trailer'}</span>
                      </span>
                    </span>
                  )}
                  <span className="face f-front">{frontInner}</span>
                  {rOn && <span className="face f-front f-rfront" aria-hidden="true">{frontInner}</span>}
                  {!smooth && rOn && (offset === 0 || rSpine) && <span className="face f-bevel-f f-rbevel-f" aria-hidden="true" />}
                  {rSpine && <span className="face f-bevel-b f-rbevel-b" aria-hidden="true" />}
                  {rSpine && <span className="face f-spine f-rspine" aria-hidden="true">{spineInner}</span>}
                  {rEdge && <span className="face f-edge f-redge" aria-hidden="true" />}
                </button>
              );
            })}
            </div>
          </section>
          )}

          {gridMode ? (!movies.tmdb && <p className="hint grid-hint">No TMDB key on the server yet, so covers are plain. Add one on the server setup page.</p>) : (
          <section className="details">
            <div className="eyebrow">
              {isTv ? 'TV SERIES' : typeLabel}
              {current.year ? <><span>•</span>{current.year}</> : null}
              {isTv ? <><span>•</span>{seasonsN} {seasonsN === 1 ? 'SEASON' : 'SEASONS'}</> : null}
              {current.runtime > 0 ? <><span>•</span>{fmtRuntime(current.runtime)}</> : null}
              {current.genres && current.genres.length ? <><span>•</span>{current.genres.join(', ').toUpperCase()}</> : null}
              {!isTv && current.watched ? <><span>•</span>WATCHED</> : null}
            </div>
            <h1>{current.title}</h1>
            {isTv && <p className="sub">{current.watchedCount} of {current.episodeCount} episodes watched</p>}
            <div className="actions">
              {buttons.map((b, i) => (
                <button key={b.text} tabIndex={-1} className={`btn ${b.primary ? 'btn-play' : ''} ${z === 'actions' && action === i ? 'is-focus' : ''}`} onClick={b.run}>
                  {b.primary && <svg viewBox="0 0 24 24" width="1.3em" height="1.3em" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor" /></svg>}
                  {b.text}
                </button>
              ))}
            </div>
            {!movies.tmdb && <p className="hint">No TMDB key on the server yet, so covers are plain. Add one on the server setup page.</p>}
          </section>
          )}
        </>
      )}

      {settingsOpen && <LocalSettings server={serverSettings} local={local} onChange={setPref} onReset={resetPrefs} onClose={() => setSettingsOpen(false)} onDebug={() => setDebugOpen(true)} />}
      {debugOpen && <DebugLog onClose={() => setDebugOpen(false)} />}

      {gridMode && actionsOpen && current && (
        <div className="gi-backdrop ga"><div className="gi-card ga-card">
          <span className={`gi-poster ${posterUrl(current.poster) ? 'has-poster' : ''}`} style={posterUrl(current.poster) ? { backgroundImage: `url(${posterUrl(current.poster)})` } : undefined} />
          <span className="gi-main">
            <span className="ga-eyebrow">{[isTv ? 'TV SERIES' : typeLabel, current.year, isTv ? `${seasonsN} ${seasonsN === 1 ? 'SEASON' : 'SEASONS'}` : '', current.runtime > 0 ? fmtRuntime(current.runtime) : '', current.genres && current.genres.length ? current.genres.join(', ').toUpperCase() : ''].filter(Boolean).join('  •  ')}</span>
            <b className="gi-title">{current.title}</b>
            {isTv ? <span className="gi-meta">{current.watchedCount} of {current.episodeCount} episodes watched</span> : (current.rating > 0 ? <span className="gi-meta">★ {current.rating.toFixed(1)}</span> : null)}
            <span className="ga-actions">
              {buttons.map((b, i) => (
                <button key={b.text} tabIndex={-1} className={`btn ${b.primary ? 'btn-play' : ''} ${action === i ? 'is-focus' : ''}`}
                  onClick={() => { if (!b.keep) setActionsOpen(false); b.run(); }}>
                  {b.primary && <svg viewBox="0 0 24 24" width="1.3em" height="1.3em" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor" /></svg>}
                  {b.text}
                </button>
              ))}
            </span>
          </span>
        </div></div>
      )}

      {gridMode && flipped && current && (
        <div className="gi-backdrop"><div className="gi-card">
          <span className={`gi-poster ${posterUrl(current.poster) ? 'has-poster' : ''}`} style={posterUrl(current.poster) ? { backgroundImage: `url(${posterUrl(current.poster)})` } : undefined} />
          <span className="gi-main">
            <b className="gi-title">{current.title}</b>
            <span className="gi-meta">{[current.year, current.runtime > 0 ? fmtRuntime(current.runtime) : '', current.rating > 0 ? `★ ${current.rating.toFixed(1)}` : '', current.genres && current.genres.length ? current.genres.join(', ') : ''].filter(Boolean).join('  ·  ')}</span>
            {current.tagline ? <i className="gi-tag">“{current.tagline}”</i> : null}
            <span className="gi-scroll" ref={infoRef}>
              <span className="gi-h">SYNOPSIS</span>
              <span className="gi-text">{current.overview || current.tag || 'No synopsis available.'}</span>
              {current.director && current.director.length ? <><span className="gi-h">{isTv ? 'CREATED BY' : 'DIRECTED BY'}</span><span className="gi-text">{current.director.join(', ')}</span></> : null}
              {current.cast && current.cast.length ? <><span className="gi-h">STARRING</span><span className="gi-text">{current.cast.join(', ')}</span></> : null}
            </span>
            <span className="gi-trailer">{!current.trailer || trailerNote ? 'No trailer available' : '▶  Watch trailer'}</span>
            <span className="gi-hint">OK trailer · ▲▼ scroll · Back close</span>
          </span>
        </div></div>
      )}

      {trailerOpen && current && current.trailer && <Trailer videoId={current.trailer} title={current.title} onClose={() => setTrailerOpen(false)} />}

      {prep && (
        <div className="picker"><div className="picker-card prep-card">
          <h2>Preparing audio</h2>
          <p>Converting the sound to Dolby Digital for your TV…</p>
          <div className="prep-bar"><i style={{ width: `${Math.round(prep.pct * 100)}%` }} /></div>
          <p className="prep-hint">{Math.round(prep.pct * 100)}% · Back to cancel</p>
        </div></div>
      )}

      {picker === 'audio' && trackData && (
        <TrackPicker title="Audio" current={typeof choice.a === 'number' ? choice.a : 'auto'}
          options={[{ key: 'auto', label: 'Automatic', note: curAudio && typeof choice.a !== 'number' ? audioShort(curAudio) : 'preferred language' }, ...trackData.audio.map((t) => ({ key: t.index, label: t.label, note: t.title && t.title.length < 24 ? t.title : '' }))]}
          onClose={() => setPicker(null)} onPick={(o) => { setChoice({ a: o.key === 'auto' ? null : o.key }); setPicker(null); }} />
      )}
      {picker === 'subs' && trackData && (
        <TrackPicker title="Subtitles"
          current={choice.s === 'off' || (!choice.s && !curSub) ? 'off' : curSub.k === 'emb' ? 'e' + curSub.i : 'x' + (trackData.external.find((x) => x.url === curSub.url) || {}).n}
          options={[{ key: 'off', label: 'Off' },
            ...trackData.subs.map((t) => ({ key: 'e' + t.index, label: t.label, note: t.image ? 'picture' : '' })),
            ...trackData.external.map((t) => ({ key: 'x' + t.n, label: t.label }))]}
          onClose={() => setPicker(null)}
          onPick={(o) => {
            if (o.key === 'off') setChoice({ s: 'off' });
            else if (o.key[0] === 'e') setChoice({ s: { k: 'emb', i: Number(o.key.slice(1)) } });
            else { const t = trackData.external.find((x) => x.n === Number(o.key.slice(1))); setChoice({ s: { k: 'ext', url: t.url, mime: t.mime, lang: t.lang, embCount: trackData.subs.length } }); }
            setPicker(null);
          }} />
      )}
      {showOpen && <Episodes host={host} show={showOpen} poster={posterUrl(showOpen.poster)} busy={playing} onPlay={(ep, fromStart) => playEpisode(showOpen, ep, fromStart)} onClose={() => setEpisodesOf(null)} />}
      {dialog && <ExitDialog onCancel={() => setDialog(false)} onChangeServer={onChangeServer} onExit={onExit} />}
    </main>
  );
}
