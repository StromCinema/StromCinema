import React, { useState } from 'react';
import { useInput } from './input.js';

const ROWS = 7;

/** A small list the viewer picks from with up / down / OK. options: [{ key, label, note }] */
export default function TrackPicker({ title, options, current, onPick, onClose }) {
  const start = Math.max(0, options.findIndex((o) => o.key === current));
  const [i, setI] = useState(start);
  useInput((name) => {
    if (name === 'back') { onClose(); return true; }
    if (name === 'up') setI((x) => Math.max(0, x - 1));
    else if (name === 'down') setI((x) => Math.min(options.length - 1, x + 1));
    else if (name === 'enter') onPick(options[i]);
    return true;
  });
  const first = Math.max(0, Math.min(i - Math.floor(ROWS / 2), options.length - ROWS));
  const shown = options.slice(first, first + ROWS);
  return (
    <div className="picker" onClick={onClose}>
      <div className="picker-card" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div className="picker-list">
          {shown.map((o, n) => {
            const idx = first + n;
            return (
              <button key={o.key} tabIndex={-1} className={`prow ${idx === i ? 'is-focus' : ''}`} onClick={() => onPick(o)}>
                <span className="pmark">{o.key === current ? '✓' : ''}</span>
                <span className="plabel">{o.label}</span>
                {o.note && <span className="pnote">{o.note}</span>}
              </button>
            );
          })}
        </div>
        {options.length > ROWS && <p className="picker-more">{i + 1} / {options.length}</p>}
      </div>
    </div>
  );
}
