// Covers are fetched with fetch() (the same way the library list is) and shown from memory as blob: URLs.
// On Android TV the WebView can refuse images that come straight from the server's http:// address,
// while fetch() to it works, so this avoids relying on image loading across origins.
import { useCallback, useEffect, useRef, useState } from 'react';
import { absoluteUrl } from './api.js';
import { dlog } from './debug.js';

const KEEP = 60;

// radius = how many titles around the selected one are kept loaded (the grid shows several rows at once)
// extra = cover paths of the OTHER category (movies <-> TV series). They are kept and pre-loaded too, so switching
// between the two does not throw away and re-fetch everything.
export function usePosters(host, items, selected, radius = 8, extra = []) {
  const extraKey = extra.join('|');
  const keep = Math.max(KEEP, (radius * 2 + 8) + extra.length + 12);
  const stat = useRef({ done: 0, fast: 0, net: 0 });
  const cache = useRef(new Map());   // poster path -> blob URL (already decoded) | 'loading' | 'failed'
  const held = useRef(new Map());    // poster path -> Image kept alive so the decoded bitmap stays in memory
  const [, bump] = useState(0);

  useEffect(() => {
    const want = [];
    for (let d = 0; d <= radius; d++) {
      for (const i of d === 0 ? [selected] : [selected - d, selected + d]) {
        const it = items[i];
        if (it && it.poster && !want.includes(it.poster)) want.push(it.poster);
      }
    }
    const c = cache.current;
    const mine = new Set(want);
    for (const p of extra) if (p && !mine.has(p)) want.push(p);     // the other category comes after the visible ones
    const todo = want.filter((p) => !c.has(p));
    if (todo.length || want.length) dlog('posters', `want ${want.length} (${extra.length} from the other tab) · in memory ${want.length - todo.length} · to fetch ${todo.length}`);
    for (const p of todo) {
      c.set(p, 'loading');
      const t0 = performance.now();
      fetch(absoluteUrl(host, p))
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
        .then((b) => {
          const ms = performance.now() - t0, st = stat.current;
          st.done++; if (ms < 25) st.fast++; else st.net++;           // < 25 ms = answered from the web view's own cache
          if (st.done % 10 === 0) { dlog('posters', `fetched ${st.done} · ${st.fast} fast (cache) / ${st.net} slow (network)`); }
          // decode the picture BEFORE a case shows it, so it never pops in half-way while the shelf is moving
          const u = URL.createObjectURL(b), im = new Image();
          im.src = u; held.current.set(p, im);
          const done = () => { c.set(p, u); bump((n) => n + 1); };
          (im.decode ? im.decode() : Promise.resolve()).then(done, done);
        })
        .catch(() => { c.set(p, 'failed'); setTimeout(() => { if (c.get(p) === 'failed') c.delete(p); }, 8000); });
    }
    if (c.size > keep) {                       // free memory for covers far away from the selection
      let dropped = 0;
      for (const [p, v] of c) {
        if (c.size <= keep) break;
        if (want.includes(p)) continue;
        dropped++;
        if (v && v !== 'loading' && v !== 'failed') URL.revokeObjectURL(v);
        c.delete(p); held.current.delete(p);
      }
      if (dropped) dlog('posters', `memory over ${keep}: dropped ${dropped} covers`);
    }
  }, [items, selected, host, radius, keep, extraKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { for (const v of cache.current.values()) if (v && v !== 'loading' && v !== 'failed') URL.revokeObjectURL(v); cache.current.clear(); }, []);

  return useCallback((p) => { const v = p ? cache.current.get(p) : ''; return v && v !== 'loading' && v !== 'failed' ? v : ''; }, []);
}
