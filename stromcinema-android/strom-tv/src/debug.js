// Small event log for finding out what the app is doing (restarts, covers, library loads ...).
// Always recording (cheap, last 150 lines, kept in localStorage so it survives an app restart).
// Shown from the gear menu ("Debug log") and echoed to the server console as "[TV debug] ..." once a server is known.
const KEY = 'strom_dbglog', MAX = 150;
function read() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }
let lines = read();
const subs = new Set();
let sendTo = null;          // 'host:port' of the Strøm server
let queue = [], timer = null;

function flush() {
  timer = null;
  if (!sendTo || !queue.length) return;
  const batch = queue; queue = [];
  try { fetch(`http://${sendTo}/api/tv/debug`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: batch }) }).catch(() => {}); } catch { /* ignore */ }
}

export function dlog(tag, msg) {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const l = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} [${tag}] ${msg}`;
  lines = [...lines, l].slice(-MAX);
  try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* ignore */ }
  subs.forEach((f) => f());
  if (sendTo) { queue.push(l); if (!timer) timer = setTimeout(flush, 800); }
}
export const getLog = () => lines;
export function clearLog() { lines = []; try { localStorage.removeItem(KEY); } catch { /* ignore */ } subs.forEach((f) => f()); }
export function subscribeLog(f) { subs.add(f); return () => subs.delete(f); }
/** Start echoing to the server console; the last lines (incl. the start-up ones) go out at once. */
export function setLogHost(host) {
  sendTo = host || null;
  if (sendTo) { queue = ['--- TV log (last lines) ---', ...lines.slice(-30)]; if (!timer) timer = setTimeout(flush, 300); }
}
