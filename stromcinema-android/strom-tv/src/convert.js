// Audio conversion for TVs that cannot play TrueHD / DTS: asks the server for a copy of the film whose
// audio track is Dolby Digital, and waits for it. (Server: /api/tv/convert/:id)
import { baseUrl } from './api.js';
import { getAudioSupport } from './native.js';

const FAMILY = (codec) => {
  const c = String(codec || '');
  if (/truehd|mlp/i.test(c)) return 'truehd';
  if (/dts-?hd|dts.*ma/i.test(c)) return 'dtshd';
  if (/dts/i.test(c)) return 'dts';
  return null;
};

/** true when this audio track should be converted. mode: 'auto' | 'on' | 'off' */
export async function needsConvert(track, mode) {
  const fam = track && FAMILY(track.codec);
  if (!fam || mode === 'off') return false;
  if (mode === 'on') return true;
  const sup = await getAudioSupport();            // what the TV / Shield can pass through; null = unknown -> convert
  return !(sup && sup[fam]);
}

async function jget(url, init) {
  const r = await fetch(url, init);
  return r.json();
}

/**
 * Converts one audio track and resolves with the stream url of the converted copy, or null if that is not
 * possible (no ffmpeg, error, cancelled) – the caller then plays the original file.
 */
export async function prepareAudio({ host, id, track, onProgress, cancelled }) {
  const b = baseUrl(host);
  try {
    const info = await jget(`${b}/api/tv/convert/info`);
    if (!info.ffmpeg) return null;
    let st = await jget(`${b}/api/tv/convert/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ track }) });
    while (st.state === 'working') {
      if (cancelled()) { fetch(`${b}/api/tv/convert/${id}?track=${track}`, { method: 'DELETE' }).catch(() => {}); return null; }
      onProgress(st.progress || 0);
      await new Promise((r) => setTimeout(r, 700));
      st = await jget(`${b}/api/tv/convert/${id}?track=${track}`);
    }
    return st.state === 'ready' && st.url ? st.url : null;
  } catch { return null; }
}
