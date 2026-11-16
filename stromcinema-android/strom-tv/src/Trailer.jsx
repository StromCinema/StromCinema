// Full-screen trailer: YouTube's embedded player (IFrame API). If YouTube refuses to play it here
// (embedding blocked, offline, no answer), the trailer is handed to the YouTube app / the default browser instead.
import React, { useEffect, useRef, useState } from 'react';
import { useInput } from './input.js';
import { openTrailerExternally } from './native.js';

let apiPromise = null;
function loadApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('offline')); };
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('timeout')), 10000);
  });
  return apiPromise;
}

export default function Trailer({ videoId, title, onClose }) {
  const holder = useRef(null);
  const player = useRef(null);
  const closed = useRef(false);
  const [state, setState] = useState('loading');   // loading | playing | paused | external

  const close = () => { if (!closed.current) { closed.current = true; onClose(); } };

  useEffect(() => {
    let dead = false, timer = null;
    const fallback = () => {
      if (dead || closed.current) return;
      setState('external');
      openTrailerExternally(videoId);
      setTimeout(close, 1800);
    };
    loadApi().then((YT) => {
      if (dead) return;
      player.current = new YT.Player(holder.current, {
        videoId, width: '100%', height: '100%',
        playerVars: { autoplay: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, origin: window.location.origin, enablejsapi: 1 },
        events: {
          onReady: (e) => {
            const f = holder.current && holder.current.tagName === 'IFRAME' ? holder.current : document.querySelector('.trailer iframe');
            if (f) f.setAttribute('tabindex', '-1');     // keys must stay with the app, not the iframe
            try { e.target.playVideo(); } catch { /* ignore */ }
            window.focus();
          },
          onStateChange: (e) => {
            if (e.data === 1) { clearTimeout(timer); setState('playing'); }
            else if (e.data === 2) setState('paused');
            else if (e.data === 0) close();               // trailer ended
          },
          onError: () => { clearTimeout(timer); fallback(); },
        },
      });
      timer = setTimeout(fallback, 12000);                // never started playing
    }).catch(fallback);
    return () => { dead = true; clearTimeout(timer); try { player.current && player.current.destroy(); } catch { /* ignore */ } };
  }, [videoId]);   // eslint-disable-line react-hooks/exhaustive-deps

  useInput((name) => {
    const p = player.current;
    if (name === 'back') { close(); return true; }
    if (state === 'external' || !p || !p.getPlayerState) return true;
    try {
      if (name === 'enter' || name === 'playpause') { if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo(); }
      else if (name === 'left') p.seekTo(Math.max(0, p.getCurrentTime() - 10), true);
      else if (name === 'right') p.seekTo(p.getCurrentTime() + 10, true);
    } catch { /* player not ready yet */ }
    return true;
  });

  return (
    <div className="trailer" role="dialog" aria-label={`Trailer: ${title || ''}`}>
      <div className="trailer-video"><div ref={holder} /></div>
      {state === 'loading' && <div className="trailer-msg"><span className="status-dot" />Loading trailer…</div>}
      {state === 'external' && <div className="trailer-msg">Opening YouTube…</div>}
      {state === 'paused' && <div className="trailer-pause">❚❚</div>}
      <div className="trailer-hint">OK pause · ◀ ▶ skip 10 s · Back close</div>
    </div>
  );
}
