// Things that must survive the app being restarted by Android while a film plays.
const RET = 'strom_returning', LIB = 'strom_libcache', MAX_AGE = 6 * 3600 * 1000;
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const del = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

export const markPlaying = () => set(RET, String(Date.now()));
export const clearPlaying = () => del(RET);
/** Called once at start-up: ms since a film was started if the app was restarted while it played, else null. */
export function consumeReturning() {
  const t = Number(get(RET) || 0);
  del(RET);
  const age = t ? Date.now() - t : -1;
  return age >= 0 && age < MAX_AGE ? age : null;
}

export function saveLibCache(host, m, t) { set(LIB, JSON.stringify({ host, m, t, at: Date.now() })); }
export function loadLibCache() {
  try { const o = JSON.parse(get(LIB) || 'null'); return o && o.host && o.m ? o : null; } catch { return null; }
}
