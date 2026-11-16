// Everything the TV says to the Strøm server over HTTP. The server owns all settings and files;
// the TV only ever asks "what is in the library?" and "play this".

export const DEFAULT_PORT = 5000;

/** "192.168.1.20", "http://192.168.1.20:5000/" or "nas.local" -> "host:port", or '' if it can't be an address. */
export function normalizeHost(input) {
  let s = String(input || '').trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
  if (!s) return '';
  if (!/^[A-Za-z0-9._-]+(:\d{1,5})?$/.test(s)) return '';
  if (!s.includes(':')) s += `:${DEFAULT_PORT}`;
  const port = Number(s.split(':')[1]);
  return port >= 1 && port <= 65535 ? s : '';
}

export const baseUrl = (host) => `http://${host}`;
export const absoluteUrl = (host, p) => (!p ? '' : /^https?:\/\//i.test(p) ? p : `${baseUrl(host)}${p}`);

async function timedFetch(url, ms, options) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctl.signal }); } finally { clearTimeout(timer); }
}

/** true only if a Strøm server answers at this address. */
export async function ping(host, ms = 2500) {
  try {
    const r = await timedFetch(`${baseUrl(host)}/api/ping`, ms);
    if (!r.ok) return false;
    const j = await r.json();
    return j && j.service === 'strom';
  } catch { return false; }
}

export class LibraryError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

/** kind: 'movies' -> /api/tv/library, 'tv' -> /api/tv/shows */
export async function fetchLibrary(host, { refresh = false, kind = 'movies' } = {}) {
  let r;
  try {
    r = await timedFetch(`${baseUrl(host)}/api/tv/${kind === 'tv' ? 'shows' : 'library'}${refresh ? '?refresh=1' : ''}`, 30000);
  } catch {
    throw new LibraryError('The server did not answer.', 'offline');
  }
  if (r.status === 404) throw new LibraryError('This server is too old for the TV app (it has no /api/tv/library). Copy tv-api.cjs next to plexus-server.cjs and restart the server.', 'old-server');
  if (!r.ok) throw new LibraryError(`The server answered with an error (${r.status}).`, 'error');
  return r.json();
}

/** Probe every address of the TV's own /24 for a Strøm server (fallback when mDNS is blocked by the router). */
export async function scanSubnet(ip, { onProgress, alive = () => true, port = DEFAULT_PORT } = {}) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  const prefix = parts.slice(0, 3).join('.');
  const hosts = [];
  for (let i = 1; i <= 254; i++) hosts.push(`${prefix}.${i}:${port}`);
  let next = 0, done = 0, found = null;
  const worker = async () => {
    while (!found && alive() && next < hosts.length) {
      const h = hosts[next++];
      if (await ping(h, 700)) found = h;
      done++;
      if (onProgress) onProgress(done / hosts.length);
    }
  };
  await Promise.all(Array.from({ length: 40 }, worker));
  return found;
}

export function formatResume(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
