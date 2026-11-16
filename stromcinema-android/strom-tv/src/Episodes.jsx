import React, { useState } from 'react';
import { formatResume } from './api.js';
import { useInput } from './input.js';

const seasonName = (n) => (n === 0 ? 'Specials' : `Season ${n}`);
const ROWS = 7;

export default function Episodes({ show, poster, busy, onPlay, onClose }) {
  const startSeason = Math.max(0, show.seasons.findIndex((s) => s.episodes.some((e) => e.id === show.continueId)));
  const [si, setSi] = useState(startSeason);
  const [ri, setRi] = useState(() => Math.max(0, show.seasons[startSeason].episodes.findIndex((e) => e.id === show.continueId)));
  const [zone, setZone] = useState('list');   // seasons | list
  const [over, setOver] = useState(false);     // "Start over" picked on the focused row

  const season = show.seasons[Math.min(si, show.seasons.length - 1)];
  const eps = season.episodes;
  const ep = eps[Math.min(ri, eps.length - 1)];

  useInput((name) => {
    if (busy) return true;
    if (name === 'back') { onClose(); return true; }
    if (zone === 'seasons') {
      if (name === 'left') { setSi((i) => Math.max(0, i - 1)); setRi(0); }
      else if (name === 'right') { setSi((i) => Math.min(show.seasons.length - 1, i + 1)); setRi(0); }
      else if (name === 'down' || name === 'enter') { setZone('list'); setOver(false); }
      return true;
    }
    if (name === 'up') { if (ri > 0) { setRi(ri - 1); setOver(false); } else setZone('seasons'); }
    else if (name === 'down') { setRi(Math.min(eps.length - 1, ri + 1)); setOver(false); }
    else if (name === 'left') setOver(false);
    else if (name === 'right') { if (ep.resumeMs > 0) setOver(true); }
    else if (name === 'enter' || name === 'playpause') onPlay(ep, over && ep.resumeMs > 0);
    else return false;
    return true;
  });

  const start = Math.max(0, Math.min(ri - 3, eps.length - ROWS));
  const rows = eps.slice(start, start + ROWS);

  return (
    <div className="episodes">
      <aside className="ep-side">
        <div className={`ep-poster ${poster ? '' : 'none'}`} style={poster ? { backgroundImage: `url(${poster})` } : undefined} />
        <h2>{show.title}</h2>
        <p>{show.year}{show.year ? ' · ' : ''}{show.episodeCount} episodes</p>
      </aside>
      <section className="ep-main">
        <div className="seasons">
          {show.seasons.map((s, i) => (
            <button key={s.season} tabIndex={-1} className={`tab ${i === si ? 'active' : ''} ${zone === 'seasons' && i === si ? 'is-focus' : ''}`}
              onClick={() => { setSi(i); setRi(0); }}>{seasonName(s.season)}</button>
          ))}
        </div>
        <div className="ep-list">
          {rows.map((e, k) => {
            const i = start + k, focused = zone === 'list' && i === ri;
            const pct = e.resumeMs > 0 && e.durationMs > 0 ? Math.min(100, (e.resumeMs / e.durationMs) * 100) : 0;
            return (
              <div key={e.id} className={`ep ${focused ? 'is-focus' : ''}`} onClick={() => { setRi(i); onPlay(e, false); }}>
                <span className="ep-no">{e.episode}</span>
                <span className="ep-title">{e.title || `Episode ${e.episode}`}</span>
                <span className="ep-meta">
                  {e.watched && <b className="seen" aria-label="watched">✓</b>}
                  {focused && e.resumeMs > 0 ? (
                    <>
                      <span className={`mini ${!over ? 'sel' : ''}`}>Resume {formatResume(e.resumeMs)}</span>
                      <span className={`mini ${over ? 'sel' : ''}`}>Start over</span>
                    </>
                  ) : e.resumeMs > 0 ? <span className="dim">{formatResume(e.resumeMs)}</span> : null}
                </span>
                {pct > 0 && <i className="ep-bar" style={{ width: `${pct}%` }} />}
              </div>
            );
          })}
        </div>
        <p className="ep-hint">OK plays · Back returns</p>
      </section>
    </div>
  );
}
