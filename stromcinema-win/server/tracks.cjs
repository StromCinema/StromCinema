'use strict';
/**
 * Lists the audio and subtitle tracks of a video file, without needing ffmpeg:
 *   - .mkv / .webm : reads the Matroska "Tracks" header
 *   - .mp4 / .m4v / .mov : reads the "moov" box
 *   - anything else (or if those fail): asks ffprobe when it is installed
 * Also finds subtitle files next to the film (Movie.en.srt, Subs/English.srt ...).
 *
 * Track numbers: `index` is the position among the audio tracks (or among the subtitle tracks) in file order.
 * Both players count tracks the same way (ExoPlayer groups, mpv --aid / --sid minus one).
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ─── languages ────────────────────────────────────────────────────────────────
const LANGS = [
  ['eng', 'en', 'English'], ['swe', 'sv', 'Swedish'], ['nor', 'no', 'Norwegian'], ['dan', 'da', 'Danish'], ['fin', 'fi', 'Finnish'],
  ['ger', 'de', 'German'], ['fre', 'fr', 'French'], ['spa', 'es', 'Spanish'], ['ita', 'it', 'Italian'], ['dut', 'nl', 'Dutch'],
  ['por', 'pt', 'Portuguese'], ['pol', 'pl', 'Polish'], ['rus', 'ru', 'Russian'], ['jpn', 'ja', 'Japanese'], ['kor', 'ko', 'Korean'],
  ['chi', 'zh', 'Chinese'], ['ara', 'ar', 'Arabic'], ['hin', 'hi', 'Hindi'], ['tur', 'tr', 'Turkish'], ['gre', 'el', 'Greek'],
  ['heb', 'he', 'Hebrew'], ['cze', 'cs', 'Czech'], ['hun', 'hu', 'Hungarian'], ['rum', 'ro', 'Romanian'], ['ice', 'is', 'Icelandic'],
  ['tha', 'th', 'Thai'], ['ukr', 'uk', 'Ukrainian'], ['vie', 'vi', 'Vietnamese'], ['ind', 'id', 'Indonesian'], ['est', 'et', 'Estonian'],
];
const ALT3 = { nob: 'nor', nno: 'nor', deu: 'ger', fra: 'fre', nld: 'dut', zho: 'chi', ces: 'cze', ell: 'gre', ron: 'rum', isl: 'ice', cmn: 'chi', yue: 'chi' };
const BY3 = new Map(LANGS.map((l) => [l[0], l]));
const BY2 = new Map(LANGS.map((l) => [l[1], l]));
const BYNAME = new Map(LANGS.map((l) => [l[2].toLowerCase(), l]));
BYNAME.set('svenska', BY3.get('swe')); BYNAME.set('norsk', BY3.get('nor')); BYNAME.set('dansk', BY3.get('dan')); BYNAME.set('suomi', BY3.get('fin'));

/** "en", "eng", "en-US", "English", "sv-SE" ... -> { code: 'eng', name: 'English' } (code '' when unknown) */
function lang(raw) {
  let s = String(raw || '').trim().toLowerCase().replace(/\0/g, '');
  if (!s || s === 'und' || s === 'mis' || s === 'zxx') return { code: '', name: '' };
  const base = s.split(/[-_]/)[0];
  const hit = BY3.get(ALT3[base] || base) || BY2.get(base) || BYNAME.get(s) || BYNAME.get(base);
  if (hit) return { code: hit[0], name: hit[2] };
  return { code: base.length === 3 ? base : '', name: base.length === 3 ? base.toUpperCase() : '' };
}

// ─── display names ────────────────────────────────────────────────────────────
const layout = (n) => ({ 1: '1.0', 2: '2.0', 3: '2.1', 4: '4.0', 5: '5.0', 6: '5.1', 7: '6.1', 8: '7.1' }[n] || (n ? `${n}ch` : ''));
const A_CODECS = {
  A_AC3: 'Dolby Digital', A_EAC3: 'Dolby Digital+', A_TRUEHD: 'Dolby TrueHD', A_MLP: 'TrueHD', A_DTS: 'DTS', 'A_DTS/EXPRESS': 'DTS Express', 'A_DTS/LOSSLESS': 'DTS-HD MA',
  A_FLAC: 'FLAC', A_OPUS: 'Opus', A_VORBIS: 'Vorbis', A_MPEG: 'MP3',
};
function audioCodecName(id) {
  if (A_CODECS[id]) return A_CODECS[id];
  if (/^A_AAC/.test(id)) return 'AAC';
  if (/^A_PCM/.test(id)) return 'PCM';
  if (/^A_MPEG/.test(id)) return 'MP3';
  return String(id || '').replace(/^A_/, '') || 'Audio';
}
const S_CODECS = { 'S_TEXT/UTF8': 'SRT', 'S_TEXT/ASS': 'ASS', 'S_TEXT/SSA': 'ASS', 'S_TEXT/WEBVTT': 'WebVTT', 'S_HDMV/PGS': 'PGS', S_VOBSUB: 'VobSub', 'S_DVBSUB': 'DVB', 'S_KATE': 'Kate' };
const IMAGE_SUBS = new Set(['PGS', 'VobSub', 'DVB']);

function finishAudio(t, i) {
  const l = lang(t.language);
  const codec = t.codec || 'Audio';
  const ch = layout(t.channels);
  return {
    index: i, lang: l.code, langName: l.name, codec, channels: t.channels || 0, layout: ch, title: t.title || '', default: !!t.default,
    label: [l.name || 'Unknown', [codec, ch].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
  };
}
function finishSub(t, i) {
  const l = lang(t.language);
  const extra = [t.forced ? 'Forced' : '', t.title && !/^(sdh|forced)$/i.test(t.title) ? t.title : (/sdh/i.test(t.title || '') ? 'SDH' : '')].filter(Boolean).join(', ');
  return {
    index: i, lang: l.code, langName: l.name, codec: t.codec || 'Sub', image: IMAGE_SUBS.has(t.codec), forced: !!t.forced, default: !!t.default, title: t.title || '',
    label: [l.name || 'Unknown', [t.codec, extra].filter(Boolean).join(' · ')].filter(Boolean).join(' · '),
  };
}

// ─── Matroska ─────────────────────────────────────────────────────────────────
const ID = { EBML: 0x1a45dfa3, SEGMENT: 0x18538067, TRACKS: 0x1654ae6b, ENTRY: 0xae, NUM: 0xd7, TYPE: 0x83, CODEC: 0x86, LANG: 0x22b59c, LANG2: 0x22b59d, NAME: 0x536e, DEFAULT: 0x88, FORCED: 0x55aa, AUDIO: 0xe1, CHANNELS: 0x9f };

function vintLen(b) { for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1; return 0; }
function readId(buf, pos) {
  const len = vintLen(buf[pos]); if (!len || len > 4 || pos + len > buf.length) return null;
  let v = 0; for (let i = 0; i < len; i++) v = v * 256 + buf[pos + i];
  return { id: v, len };
}
function readSize(buf, pos) {
  const len = vintLen(buf[pos]); if (!len || pos + len > buf.length) return null;
  let v = buf[pos] & (0xff >> len), allOnes = v === (0xff >> len);
  for (let i = 1; i < len; i++) { v = v * 256 + buf[pos + i]; if (buf[pos + i] !== 0xff) allOnes = false; }
  return { size: allOnes ? -1 : v, len };
}
function* children(buf, start, end) {
  let p = start;
  while (p < end) {
    const id = readId(buf, p); if (!id) return;
    const sz = readSize(buf, p + id.len); if (!sz) return;
    const dataStart = p + id.len + sz.len;
    const dataEnd = sz.size < 0 ? end : Math.min(end, dataStart + sz.size);
    yield { id: id.id, start: dataStart, end: dataEnd, truncated: sz.size >= 0 && dataStart + sz.size > end };
    if (sz.size < 0) return;
    p = dataStart + sz.size;
  }
}
const uint = (buf, s, e) => { let v = 0; for (let i = s; i < e; i++) v = v * 256 + buf[i]; return v; };
const str = (buf, s, e) => buf.toString('utf8', s, e).replace(/\0.*$/s, '');

function parseMkv(buf) {
  const audio = [], subs = [];
  for (const top of children(buf, 0, buf.length)) {
    if (top.id !== ID.SEGMENT) continue;
    for (const c of children(buf, top.start, top.end)) {
      if (c.id !== ID.TRACKS) continue;
      for (const e of children(buf, c.start, c.end)) {
        if (e.id !== ID.ENTRY) continue;
        const t = { type: 0, codec: '', language: 'eng', title: '', default: true, forced: false, channels: 0 };
        let bcp = '';
        for (const f of children(buf, e.start, e.end)) {
          if (f.id === ID.TYPE) t.type = uint(buf, f.start, f.end);
          else if (f.id === ID.CODEC) t.codec = str(buf, f.start, f.end);
          else if (f.id === ID.LANG) t.language = str(buf, f.start, f.end);
          else if (f.id === ID.LANG2) bcp = str(buf, f.start, f.end);
          else if (f.id === ID.NAME) t.title = str(buf, f.start, f.end);
          else if (f.id === ID.DEFAULT) t.default = uint(buf, f.start, f.end) !== 0;
          else if (f.id === ID.FORCED) t.forced = uint(buf, f.start, f.end) !== 0;
          else if (f.id === ID.AUDIO) for (const a of children(buf, f.start, f.end)) if (a.id === ID.CHANNELS) t.channels = uint(buf, a.start, a.end);
        }
        if (bcp) t.language = bcp;
        if (t.type === 2) audio.push({ ...t, codec: audioCodecName(t.codec) });
        else if (t.type === 17) subs.push({ ...t, codec: S_CODECS[t.codec] || String(t.codec).replace(/^S_/, '') });
      }
      return { audio, subs, found: true };
    }
  }
  return { audio, subs, found: false };
}

// ─── MP4 ──────────────────────────────────────────────────────────────────────
function boxes(buf, start, end) {
  const out = []; let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p); const type = buf.toString('latin1', p + 4, p + 8); let hdr = 8;
    if (size === 1) { if (p + 16 > end) break; size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const MP4_A = { 'ac-3': 'Dolby Digital', 'ec-3': 'Dolby Digital+', mp4a: 'AAC', alac: 'ALAC', fLaC: 'FLAC', Opus: 'Opus', mlpa: 'TrueHD', dtsc: 'DTS', dtsh: 'DTS-HD', dtsl: 'DTS-HD MA', dtse: 'DTS Express', '.mp3': 'MP3' };
const MP4_S = { tx3g: 'Text', wvtt: 'WebVTT', stpp: 'TTML', c608: 'CC', c708: 'CC' };

function parseMp4Moov(buf) {
  const audio = [], subs = [];
  for (const trak of boxes(buf, 0, buf.length).filter((b) => b.type === 'trak')) {
    const mdia = boxes(buf, trak.start, trak.end).find((b) => b.type === 'mdia'); if (!mdia) continue;
    let handler = '', language = 'und', codec = '', channels = 0, title = '';
    for (const b of boxes(buf, mdia.start, mdia.end)) {
      if (b.type === 'hdlr') handler = buf.toString('latin1', b.start + 8, b.start + 12);
      else if (b.type === 'mdhd') {
        const v = buf[b.start], o = b.start + (v === 1 ? 32 : 20), l = buf.readUInt16BE(o);
        language = [l >> 10, (l >> 5) & 31, l & 31].map((x) => String.fromCharCode(x + 0x60)).join('');
      } else if (b.type === 'minf') {
        const stbl = boxes(buf, b.start, b.end).find((x) => x.type === 'stbl');
        const stsd = stbl && boxes(buf, stbl.start, stbl.end).find((x) => x.type === 'stsd');
        if (stsd && stsd.end - stsd.start > 16) {
          const e = stsd.start + 8; codec = buf.toString('latin1', e + 4, e + 8);
          if (e + 26 <= stsd.end) channels = buf.readUInt16BE(e + 24);
        }
      }
    }
    const udta = boxes(buf, trak.start, trak.end).find((b) => b.type === 'udta');
    if (udta) { const n = boxes(buf, udta.start, udta.end).find((b) => b.type === 'name'); if (n) title = buf.toString('utf8', n.start, n.end).replace(/\0/g, ''); }
    if (handler === 'soun') audio.push({ codec: MP4_A[codec] || codec, language, channels, title, default: audio.length === 0 });
    else if (handler === 'sbtl' || handler === 'subt' || handler === 'text' || handler === 'clcp') subs.push({ codec: MP4_S[codec] || codec, language, title, default: false, forced: false });
  }
  return { audio, subs };
}

function readMp4(fd, size) {
  let pos = 0; const head = Buffer.alloc(16);
  while (pos + 8 <= size) {
    fs.readSync(fd, head, 0, 16, pos);
    let boxSize = head.readUInt32BE(0); const type = head.toString('latin1', 4, 8); let hdr = 8;
    if (boxSize === 1) { boxSize = Number(head.readBigUInt64BE(8)); hdr = 16; } else if (boxSize === 0) boxSize = size - pos;
    if (boxSize < hdr) break;
    if (type === 'moov') {
      if (boxSize > 64 * 1024 * 1024) return null;
      const b = Buffer.alloc(boxSize - hdr); fs.readSync(fd, b, 0, b.length, pos + hdr);
      return parseMp4Moov(b);
    }
    pos += boxSize;
  }
  return null;
}

// ─── ffprobe (fallback) ───────────────────────────────────────────────────────
function ffprobe(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { timeout: 10000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      try {
        const audio = [], subs = [];
        for (const s of JSON.parse(out).streams || []) {
          const tags = s.tags || {}, disp = s.disposition || {};
          if (s.codec_type === 'audio') {
            const prof = String(s.profile || '');
            const names = { ac3: 'Dolby Digital', eac3: 'Dolby Digital+', truehd: 'Dolby TrueHD', dts: /MA/i.test(prof) ? 'DTS-HD MA' : /HRA|HD/i.test(prof) ? 'DTS-HD' : 'DTS', aac: 'AAC', flac: 'FLAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis' };
            audio.push({ codec: names[s.codec_name] || String(s.codec_name || '').toUpperCase(), language: tags.language, channels: s.channels || 0, title: tags.title || '', default: !!disp.default });
          } else if (s.codec_type === 'subtitle') {
            const names = { subrip: 'SRT', srt: 'SRT', ass: 'ASS', ssa: 'ASS', webvtt: 'WebVTT', hdmv_pgs_subtitle: 'PGS', dvd_subtitle: 'VobSub', dvb_subtitle: 'DVB', mov_text: 'Text' };
            subs.push({ codec: names[s.codec_name] || String(s.codec_name || '').toUpperCase(), language: tags.language, title: tags.title || '', default: !!disp.default, forced: !!disp.forced });
          }
        }
        resolve({ audio, subs });
      } catch { resolve(null); }
    });
  });
}

// ─── public: embedded tracks (cached by path + modification time) ─────────────
const cache = new Map();

async function readEmbedded(file) {
  let st; try { st = fs.statSync(file); } catch { return { audio: [], subs: [] }; }
  const key = file + '|' + st.mtimeMs + '|' + st.size;
  if (cache.has(key)) return cache.get(key);
  let r = null;
  const ext = path.extname(file).toLowerCase();
  try {
    const fd = fs.openSync(file, 'r');
    try {
      if (ext === '.mkv' || ext === '.webm') {
        const buf = Buffer.alloc(Math.min(st.size, 6 * 1024 * 1024)); const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const m = parseMkv(buf.subarray(0, n)); if (m.found) r = m;
      } else if (['.mp4', '.m4v', '.mov'].includes(ext)) r = readMp4(fd, st.size);
    } finally { fs.closeSync(fd); }
  } catch { r = null; }
  if (!r || (!r.audio.length && !r.subs.length)) r = (await ffprobe(file)) || r || { audio: [], subs: [] };
  const out = { audio: r.audio.map(finishAudio), subs: r.subs.map(finishSub) };
  cache.set(key, out);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return out;
}

// ─── public: subtitle files next to the film ──────────────────────────────────
const SUB_EXT = { '.srt': 'application/x-subrip', '.ass': 'text/x-ssa', '.ssa': 'text/x-ssa', '.vtt': 'text/vtt' };

function findExternalSubs(file) {
  const dir = path.dirname(file), base = path.basename(file, path.extname(file)).toLowerCase();
  const found = [];
  const scan = (d, requirePrefix) => {
    let names; try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const ext = path.extname(name).toLowerCase();
      if (!SUB_EXT[ext]) continue;
      const stem = path.basename(name, ext).toLowerCase();
      if (requirePrefix && !stem.startsWith(base)) continue;
      const rest = requirePrefix ? stem.slice(base.length) : stem;
      // language = the last word of the name that is a language ("movie.en.srt", "2_English.srt", "Swedish.forced.srt")
      let l = { code: '', name: '' };
      for (const w of rest.split(/[^a-zåäö]+/i).filter(Boolean).reverse()) { const x = lang(w); if (x.code || x.name) { l = x; break; } }
      const forced = /forced/.test(rest), sdh = /sdh|hearing/.test(rest);
      found.push({ full: path.join(d, name), ext, lang: l.code, langName: l.name, forced, sdh });
    }
  };
  scan(dir, true);
  for (const sub of ['Subs', 'Subtitles', 'subs', 'subtitles']) {
    const d = path.join(dir, sub);
    try { if (fs.statSync(d).isDirectory()) { scan(d, false); for (const x of fs.readdirSync(d)) { const dd = path.join(d, x); try { if (fs.statSync(dd).isDirectory()) scan(dd, false); } catch { /* skip */ } } } } catch { /* none */ }
  }
  return found.slice(0, 16).map((x, i) => ({
    n: i, full: x.full, mime: SUB_EXT[x.ext], lang: x.lang, langName: x.langName, codec: x.ext.slice(1).toUpperCase(), forced: x.forced,
    label: [x.langName || 'Unknown', x.ext.slice(1).toUpperCase() + (x.forced ? ' · Forced' : x.sdh ? ' · SDH' : ''), 'external'].join(' · '),
  }));
}

module.exports = { readEmbedded, findExternalSubs, lang, parseMkv, parseMp4Moov, LANGS: LANGS.map((l) => ({ code: l[0], name: l[2] })) };
