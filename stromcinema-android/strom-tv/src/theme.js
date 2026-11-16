// Background colour: three tones for the radial gradient (centre, middle, edge) and a glow under the shelf.
const PRESETS = {
  purple:   ['#25134e', '#130d29', '#0b0916'],
  blue:     ['#10264f', '#0b1630', '#070c1c'],
  teal:     ['#0f3a3d', '#0a2326', '#061416'],
  green:    ['#17391f', '#0e2214', '#08140c'],
  wine:     ['#4a1424', '#2a0c16', '#14060b'],
  charcoal: ['#2a2a2e', '#18181b', '#0c0c0e'],
  black:    ['#141414', '#0a0a0a', '#000000'],
};
const KEY = 'strom_bg';
export const BACKGROUND_PRESETS = PRESETS;

const mix = (hex, k) => {           // darken a #rrggbb colour: k = 0 (same) .. 1 (black)
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - k)));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
};

export function applyBackground(value) {
  let tones = PRESETS[value];
  if (!tones && /^#[0-9a-fA-F]{6}$/.test(value || '')) tones = [value, mix(value, 0.55), mix(value, 0.78)];
  if (!tones) tones = PRESETS.purple;
  const r = document.documentElement.style;
  r.setProperty('--bg0', tones[0]); r.setProperty('--bg1', tones[1]); r.setProperty('--bg2', tones[2]);
  r.setProperty('--glow', tones[0] + '66');
  try { localStorage.setItem(KEY, value || 'purple'); } catch { /* ignore */ }
}

export function applySavedBackground() {
  let v = 'purple';
  try { v = localStorage.getItem(KEY) || 'purple'; } catch { /* ignore */ }
  applyBackground(v);
}
