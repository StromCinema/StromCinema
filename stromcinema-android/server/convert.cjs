/**
 * Audio conversion for TVs that cannot play TrueHD / DTS(-HD).
 * Makes a copy of the film where the video is copied untouched and ONE audio track is
 * re-encoded to Dolby Digital (AC3, 5.1 max). The copy is a normal seekable .mkv file.
 * Needs ffmpeg (ffmpeg.exe next to the app, in the data folder, "ffmpegPath" in the config, or on PATH).
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const KEEP_FILES = 2;               // converted copies kept on disk (oldest are deleted)
const jobs = new Map();             // key -> { state, progress, error, proc, file }

module.exports = function createConverter({ baseDir, getConfig }) {
  const dir = path.join(baseDir, 'converted');
  const exe = process.platform === 'win32' ? '.exe' : '';
  let found; // cached ffmpeg location

  function candidates() {
    const cfg = (getConfig && getConfig()) || {};
    const list = [];
    if (cfg.ffmpegPath) list.push(cfg.ffmpegPath);
    if (process.env.STROM_FFMPEG) list.push(process.env.STROM_FFMPEG);
    const dirs = [path.dirname(process.execPath), process.resourcesPath, baseDir, path.join(__dirname, '..'), __dirname, path.join(__dirname, '..', '..')].filter(Boolean);
    for (const d of dirs) { list.push(path.join(d, 'ffmpeg' + exe)); list.push(path.join(d, 'ffmpeg', 'ffmpeg' + exe)); list.push(path.join(d, 'ffmpeg', 'bin', 'ffmpeg' + exe)); }
    list.push('ffmpeg');
    return list;
  }
  function check(bin) {
    return new Promise((res) => execFile(bin, ['-version'], { timeout: 8000, windowsHide: true }, (e) => res(!e)));
  }
  async function ffmpegPath() {
    if (found) return found;
    for (const c of candidates()) {
      if (c !== 'ffmpeg' && !fs.existsSync(c)) continue;
      if (await check(c)) { found = c; return c; }
    }
    return null;
  }
  // length of the film, read from ffmpeg's own banner (so ffprobe.exe is not needed)
  function duration(ff, file) {
    return new Promise((res) => execFile(ff, ['-hide_banner', '-i', file], { timeout: 15000, windowsHide: true }, (e, out, err) => {
      const m = String(err || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      res(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0);
    }));
  }

  const nameFor = (id, track) => `${id}-a${track}.mkv`;
  const keyFor = (id, track) => `${id}|${track}`;
  function prune(keepName) {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mkv') && f !== keepName)
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const x of files.slice(Math.max(0, KEEP_FILES - 1))) { try { fs.unlinkSync(path.join(dir, x.f)); } catch { /* in use */ } }
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.part')) { const k = [...jobs.values()].some((j) => j.state === 'working' && j.part === path.join(dir, f)); if (!k) try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
    } catch { /* no folder yet */ }
  }

  /** status of (or start) the conversion of one audio track. */
  async function start({ id, file, track, channels, container }) {
    const key = keyFor(id, track), name = nameFor(id, track), out = path.join(dir, name);
    const old = jobs.get(key);
    if (old && old.state === 'working') return status(id, track);
    try {
      const a = fs.statSync(out), b = fs.statSync(file);
      if (a.size > 1024 && a.mtimeMs >= b.mtimeMs) { jobs.set(key, { state: 'ready', progress: 1, file: name }); fs.utimesSync(out, new Date(), new Date()); return status(id, track); }
    } catch { /* not converted yet */ }
    const ff = await ffmpegPath();
    if (!ff) { jobs.set(key, { state: 'error', error: 'ffmpeg not found' }); return status(id, track); }
    fs.mkdirSync(dir, { recursive: true });
    prune(name);
    const total = await duration(ff, file);
    const part = out + '.part';
    const mp4 = /\.(mp4|m4v|mov)$/i.test(file);
    const ch = Number(channels) || 6;
    const args = ['-y', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-i', file,
      '-map', '0:v:0', '-map', `0:a:${Number(track)}`, '-map', '0:s?',
      '-c:v', 'copy', '-c:a', 'ac3', '-b:a', ch <= 2 ? '224k' : '640k'];
    if (ch > 6) args.push('-ac', '6');
    args.push('-c:s', mp4 ? 'srt' : 'copy', '-map_chapters', '0', '-f', 'matroska', part);
    const job = { state: 'working', progress: 0, part, started: Date.now() };
    jobs.set(key, job);
    let err = '';
    const p = spawn(ff, args, { windowsHide: true });
    job.proc = p;
    p.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_(?:us|ms)=(\d+)/g);
      if (m && total) { const v = Number(m[m.length - 1].split('=')[1]) / 1e6; job.progress = Math.max(0, Math.min(0.99, v / total)); }
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', (e) => { job.state = 'error'; job.error = e.message; });
    p.on('close', (code) => {
      job.proc = null;
      if (job.state === 'cancelled') { try { fs.unlinkSync(part); } catch { /* ignore */ } return; }
      if (code === 0) {
        try { fs.renameSync(part, out); job.state = 'ready'; job.progress = 1; job.file = name; return; } catch (e) { err = e.message; }
      }
      job.state = 'error'; job.error = err.trim().split('\n').pop() || ('ffmpeg exited with ' + code);
      try { fs.unlinkSync(part); } catch { /* ignore */ }
    });
    return status(id, track);
  }

  function status(id, track) {
    const j = jobs.get(keyFor(id, track));
    if (!j) return { state: 'none' };
    return { state: j.state, progress: Math.round((j.progress || 0) * 1000) / 1000, error: j.error, url: j.state === 'ready' ? `/api/tv/converted/${j.file}` : undefined };
  }
  function cancel(id, track) {
    const j = jobs.get(keyFor(id, track));
    if (j && j.state === 'working' && j.proc) { j.state = 'cancelled'; try { j.proc.kill(); } catch { /* ignore */ } }
    jobs.delete(keyFor(id, track));
  }
  function fileFor(name) {
    if (!/^win-[0-9a-f]{24}-a\d{1,2}\.mkv$/.test(name)) return null;
    const f = path.join(dir, name);
    return fs.existsSync(f) ? f : null;
  }
  return { ffmpegPath, start, status, cancel, fileFor };
};
