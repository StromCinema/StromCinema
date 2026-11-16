import React, { useEffect, useState } from 'react';
import { useInput } from './input.js';
import { clearLog, getLog, subscribeLog } from './debug.js';

const PAGE = 14;

export default function DebugLog({ onClose }) {
  const [, bump] = useState(0);
  const [top, setTop] = useState(null);               // null = follow the newest line
  useEffect(() => subscribeLog(() => bump((n) => n + 1)), []);
  const all = getLog();
  const start = top === null ? Math.max(0, all.length - PAGE) : Math.min(top, Math.max(0, all.length - PAGE));
  useInput((name) => {
    if (name === 'back' || name === 'enter') { onClose(); return true; }
    if (name === 'up') setTop(Math.max(0, start - 3));
    else if (name === 'down') { const n = start + 3; setTop(n >= all.length - PAGE ? null : n); }
    else if (name === 'left') setTop(Math.max(0, start - PAGE));
    else if (name === 'right') { const n = start + PAGE; setTop(n >= all.length - PAGE ? null : n); }
    else if (name === 'play' || name === 'playpause') { clearLog(); setTop(null); }
    return true;
  });
  return (
    <div className="dbg-backdrop" role="dialog" aria-label="Debug log">
      <div className="dbg-card">
        <h2>DEBUG LOG <span>{all.length ? `${start + 1}–${Math.min(all.length, start + PAGE)} of ${all.length}` : 'empty'}</span></h2>
        <pre>{all.slice(start, start + PAGE).join('\n') || 'Nothing logged yet.'}</pre>
        <p className="ls-hint">▲ ▼ scroll · ◀ ▶ page · Play/Pause clear · Back close</p>
      </div>
    </div>
  );
}
