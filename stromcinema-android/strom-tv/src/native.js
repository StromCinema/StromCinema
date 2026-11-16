// The bridge to Android. On the TV every call lands in StromPlayerPlugin.java.
// In a desktop browser (npm run dev) the same calls are answered by stromPlayer.web.js,
// so the whole app can be tried without a TV.
import { registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';

const StromPlayer = registerPlugin('StromPlayer', {
  web: () => import('./stromPlayer.web.js').then((m) => new m.StromPlayerWeb()),
});

// Inside the Windows app (Electron) the server is built in and playback goes to mpv; preload.cjs provides window.stromDesktop.
export const desktop = typeof window !== 'undefined' && window.stromDesktop ? window.stromDesktop : null;
export const isDesktop = !!desktop;

export async function getSavedServer() {
  if (desktop) return desktop.host;
  try { return (await StromPlayer.getServer()).host || ''; } catch { return ''; }
}
export async function saveServer(host) {
  try { await StromPlayer.setServer({ host }); } catch { /* not fatal */ }
}
export async function forgetServer() {
  try { await StromPlayer.clearServer(); } catch { /* not fatal */ }
}
/** "ip:port" of a server found by mDNS, or null. */
export async function discoverServer() {
  try {
    const r = await StromPlayer.discoverServer();
    return r && r.host ? `${r.host}:${r.port || 5000}` : null;
  } catch { return null; }
}
export async function getLocalIp() {
  try { return (await StromPlayer.getLocalIp()).ip || ''; } catch { return ''; }
}
/**
 * Opens Android's ExoPlayer screen. Resolves when the viewer leaves it:
 * { positionMs, durationMs }. The player also reports progress to the server by itself.
 */
export function playVideo(opts) {
  const o = { ...opts, startTimeMs: Math.round(opts.startTimeMs || 0) };   // also carries the audio / subtitle choice
  if (desktop) return desktop.play(o);
  return StromPlayer.play(o);
}

/** Which audio formats this TV / Shield can pass through: { truehd, dtshd, dts, eac3 } or null if unknown (desktop / old Android). */
export async function getAudioSupport() {
  if (desktop) return null;
  try { const r = await StromPlayer.getAudioSupport(); return r && typeof r.truehd === 'boolean' ? r : null; } catch { return null; }
}

/** Hands a YouTube trailer to the YouTube app (Android) or the default browser (Windows / browser). */
export function openTrailerExternally(key) {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(key)}`;
  try {
    if (desktop) return desktop.openExternal(url);
    return StromPlayer.openYouTube({ key }).catch(() => window.open(url, '_blank'));
  } catch { return undefined; }
}

export function onBackButton(handler) {
  let handle = null, removed = false;
  App.addListener('backButton', handler).then((h) => { if (removed) h.remove(); else handle = h; }).catch(() => {});
  return () => { removed = true; if (handle) handle.remove(); };
}
export function openSettings() {
  if (desktop) desktop.openSettings();
}
export function exitApp() {
  if (desktop) { desktop.quit(); return; }
  App.exitApp().catch(() => {});
}
