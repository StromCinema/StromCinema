// "View settings" for THIS device: layout, sort, animation, cover fit, background colour.
// Stored on the device (localStorage); anything left on "Server default" follows the server's setup page.
import React, { useState } from 'react';
import { useInput } from './input.js';
import { BACKGROUND_PRESETS } from './theme.js';

const KEY = 'strom_local';
const FIELDS = ['pose', 'sort', 'quality', 'fit', 'background'];

export function loadLocalPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || '{}');
    const out = {};
    for (const k of FIELDS) if (typeof o[k] === 'string' && o[k]) out[k] = o[k];
    return out;
  } catch { return {}; }
}
export function saveLocalPrefs(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }

const ROWS = [
  { key: 'pose', label: 'Layout', opts: [['fan', 'Fan'], ['shelf', 'Shelf'], ['grid', 'Grid (posters)']] },
  { key: 'sort', label: 'Sort', opts: [['title', 'Title'], ['added', 'Recently added']] },
  { key: 'quality', label: 'Animation', opts: [['smooth', 'Smooth'], ['full', 'Full']] },
  { key: 'fit', label: 'Cover fit', opts: [['fill', 'Fill'], ['fit', 'Fit'], ['stretch', 'Stretch']] },
  { key: 'background', label: 'Background colour', opts: [['purple', 'Purple'], ['blue', 'Blue'], ['teal', 'Teal'], ['green', 'Green'], ['wine', 'Wine red'], ['charcoal', 'Charcoal'], ['black', 'Black']] },
];

export default function LocalSettings({ server, local, onChange, onReset, onClose, onDebug }) {
  const [row, setRow] = useState(0);
  const total = ROWS.length + 2;                       // + "debug log" + "use the server settings"

  const labelOf = (r, v) => { const o = r.opts.find((x) => x[0] === v); return o ? o[1] : (v && /^#/.test(v) ? 'Custom' : String(v || '')); };
  const step = (r, dir) => {
    const list = [undefined, ...r.opts.map((o) => o[0])];
    const i = Math.max(0, list.indexOf(local[r.key]));
    onChange(r.key, list[(i + dir + list.length) % list.length]);
  };

  useInput((name) => {
    if (name === 'back') { onClose(); return true; }
    if (name === 'up') setRow((i) => Math.max(0, i - 1));
    else if (name === 'down') setRow((i) => Math.min(total - 1, i + 1));
    else if (row < ROWS.length && (name === 'left' || name === 'right')) step(ROWS[row], name === 'right' ? 1 : -1);
    else if (name === 'enter') { if (row < ROWS.length) step(ROWS[row], 1); else if (row === ROWS.length) onDebug(); else onReset(); }
    return true;
  });

  return (
    <div className="ls-backdrop" role="dialog" aria-label="View settings">
      <div className="ls-card">
        <h2>VIEW SETTINGS</h2>
        {ROWS.map((r, i) => {
          const own = local[r.key];
          const shown = own ? labelOf(r, own) : `Server default · ${labelOf(r, server[r.key])}`;
          return (
            <div key={r.key} className={`ls-row ${row === i ? 'is-focus' : ''}`} onClick={() => { setRow(i); step(r, 1); }}>
              <span className="ls-label">{r.label}</span>
              <span className={`ls-value ${own ? 'own' : ''}`}>
                <i>‹</i>
                {r.key === 'background' && <b className={`ls-swatch bg-${own || server.background}`} />}
                {shown}
                <i>›</i>
              </span>
            </div>
          );
        })}
        <div className={`ls-row ls-reset ${row === ROWS.length ? 'is-focus' : ''}`} onClick={onDebug}>
          <span className="ls-label">Debug log</span><span className="ls-value">open ›</span>
        </div>
        <div className={`ls-row ls-reset ${row === ROWS.length + 1 ? 'is-focus' : ''}`} onClick={onReset}>
          <span className="ls-label">Use the server settings for everything</span>
        </div>
        <p className="ls-hint">▲ ▼ choose · ◀ ▶ change · Back close</p>
      </div>
    </div>
  );
}
