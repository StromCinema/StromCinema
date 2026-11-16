// Audio / subtitle tracks: asking the server what a film contains, and remembering what the viewer picked per film.
import { baseUrl } from './api.js';

const cache = new Map();

/** { audio:[{index,lang,langName,codec,layout,label,default}], subs:[...], external:[{n,label,lang,url,mime}] } or null */
export async function fetchTracks(host, id) {
  const key = host + '|' + id;
  if (cache.has(key)) return cache.get(key);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${baseUrl(host)}/api/tv/tracks/${id}`, { signal: ctl.signal });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    cache.set(key, j);
    return j;
  } catch { return null; } finally { clearTimeout(timer); }
}

const KEY = 'strom_tracks';
export function loadChoices() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
export function saveChoices(all) {
  try {
    const keys = Object.keys(all);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

/** the audio track that will play when the viewer has not chosen one: preferred language, else the file's default */
export function defaultAudio(data, pref) {
  if (!data || !data.audio.length) return null;
  const a = data.audio;
  if (pref && pref !== 'any') { const m = a.filter((x) => x.lang === pref); if (m.length) return m.find((x) => x.default) || m[0]; }
  return a.find((x) => x.default) || a[0];
}
/** the subtitle that will show when the viewer has not chosen: the server's default language, else none */
export function defaultSub(data, pref) {
  if (!data || !pref || pref === 'off') return null;
  const emb = data.subs.find((x) => x.lang === pref && !x.forced);
  if (emb) return { k: 'emb', i: emb.index, label: emb.label };
  const ext = data.external.find((x) => x.lang === pref && !x.forced);
  return ext ? { k: 'ext', url: ext.url, mime: ext.mime, lang: ext.lang, label: ext.label } : null;
}

const short = (t) => [t.langName || 'Unknown', t.codec, t.layout].filter(Boolean).join(' ');
export const audioShort = short;
export const subShort = (t) => [t.langName || 'Unknown', t.codec === 'SRT' ? '' : t.codec].filter(Boolean).join(' ');
