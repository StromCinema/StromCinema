/**
 * Seek preview thumbnails ("trick play", like Netflix).
 * For every film ffmpeg makes sprite sheets: one small frame every INTERVAL seconds, tiled COLS x ROWS per JPEG,
 * plus a small JSON file that describes the grid. The TV app downloads these when playback starts and cuts the
 * right tile out of a sheet while the user scrubs - no network or video decoding is needed at that moment.
 *
 * Needs ffmpeg (same lookup as convert.cjs). Without ffmpeg nothing is generated and the TV shows no preview.
 * Files live in <baseDir>/trickplay/  (<id>.json, <id>-0.jpg, <id>-1.jpg ...). Safe to delete the folder.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const INTERVAL = 5;            // seconds between thumbnails
const TILE_W = 320, TILE_H = 180;
const COLS = 10, ROWS = 10;    // 100 thumbnails (500 s of film) per sheet
const PER_SHEET = COLS * ROWS;

module.exports = function createTrickplay({ baseDir, ffmpegPath, getEnabled }) {
  const dir = path.join(baseDir, 'trickplay');
  const jobs = new Map();      // id -> { state: 'queued'|'working'|'done'|'error', file, proc, error }
  const queue = [];            // ids waiting, first = next
  let running = false;

  const jsonFile = (id) => path.join(dir, id + '.json');
  const sheetFile = (id, n) => path.join(dir, `${id}-${n}.jpg`);
  const readJson = (id) => { try { return JSON.parse(fs.readFileSync(jsonFile(id), 'utf8')); } catch { return null; } };

  function duration(ff, file) {
    return new Promise((res) => execFile(ff, ['-hide_banner', '-i', file], { timeout: 20000, windowsHide: true }, (e, out, err) => {
      const m = String(err || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      res(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0);
    }));
  }

  function removeFiles(id) {
    try { for (const f of fs.readdirSync(dir)) if (f === id + '.json' || (f.startsWith(id + '-') && f.endsWith('.jpg'))) fs.unlinkSync(path.join(dir, f)); } catch { /* no folder yet */ }
  }

  /** already generated for this exact file? */
  function isCurrent(id, file) {
    const j = readJson(id);
    if (!j || !j.done || j.interval !== INTERVAL) return false;
    try { const st = fs.statSync(file); return j.srcSize === st.size && Math.abs(j.srcMtime - st.mtimeMs) < 2000; } catch { return false; }
  }

  /** add films to the work list. items: [{ id, full }]. Already finished ones are skipped. */
  function enqueue(items) {
    if (getEnabled && !getEnabled()) return;
    for (const it of items) {
      if (!it || !it.id || !it.full || jobs.has(it.id)) continue;
      if (isCurrent(it.id, it.full)) { jobs.set(it.id, { state: 'done' }); continue; }
      jobs.set(it.id, { state: 'queued', file: it.full });
      queue.push(it.id);
    }
    pump();
  }

  /** the film is being opened right now: move it to the front of the line. */
  function prioritize(id, file) {
    if (getEnabled && !getEnabled()) return;
    let j = jobs.get(id);
    if (!j || j.state === 'error') { j = { state: 'queued', file }; jobs.set(id, j); }
    if (j.state === 'queued') {
      const i = queue.indexOf(id);
      if (i > 0) queue.splice(i, 1);
      if (i !== 0) queue.unshift(id);
      pump();
    }
  }

  async function pump() {
    if (running) return;
    const id = queue.shift();
    if (!id) return;
    running = true;
    try { await generate(id); } catch (e) { const j = jobs.get(id); if (j) { j.state = 'error'; j.error = e.message; } }
    running = false;
    setImmediate(pump);
  }

  function runFfmpeg(ff, file, id, vsyncArgs) {
    const vf = `fps=1/${INTERVAL},scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2,tile=${COLS}x${ROWS}`;
    const args = ['-y', '-nostdin', '-v', 'error', '-skip_frame', 'nokey', '-i', file,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', vf, ...vsyncArgs, '-q:v', '6', '-start_number', '0', path.join(dir, `${id}-%d.jpg`)];
    return new Promise((resolve) => {
      let err = '';
      const p = spawn(ff, args, { windowsHide: true });
      const j = jobs.get(id); if (j) j.proc = p;
      try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed - fine */ }
      p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      p.on('error', (e) => resolve({ code: -1, err: e.message }));
      p.on('close', (code) => { if (j) j.proc = null; resolve({ code, err }); });
    });
  }

  async function generate(id) {
    const j = jobs.get(id);
    if (!j || j.state !== 'queued') return;
    const file = j.file;
    const ff = await ffmpegPath();
    if (!ff) { j.state = 'error'; j.error = 'ffmpeg not found'; return; }
    const st = fs.statSync(file);
    const total = await duration(ff, file);
    if (!total) { j.state = 'error'; j.error = 'unknown duration'; return; }
    j.state = 'working';
    fs.mkdirSync(dir, { recursive: true });
    removeFiles(id);
    const count = Math.ceil(total / INTERVAL);
    const meta = { interval: INTERVAL, tileW: TILE_W, tileH: TILE_H, cols: COLS, rows: ROWS, count, sheets: Math.ceil(count / PER_SHEET),
      srcSize: st.size, srcMtime: st.mtimeMs, done: false };
    fs.writeFileSync(jsonFile(id), JSON.stringify(meta));   // the app can already start using finished sheets
    let r = await runFfmpeg(ff, file, id, ['-fps_mode', 'passthrough']);
    if (r.code !== 0 && /Unrecognized option|fps_mode/i.test(r.err)) r = await runFfmpeg(ff, file, id, ['-vsync', '0']);   // older ffmpeg
    if (r.code !== 0 || !fs.existsSync(sheetFile(id, 0))) {
      j.state = 'error'; j.error = (r.err.trim().split('\n').pop() || ('ffmpeg exited with ' + r.code));
      removeFiles(id);
      return;
    }
    meta.sheets = fs.readdirSync(dir).filter((f) => f.startsWith(id + '-') && f.endsWith('.jpg')).length;
    meta.done = true;
    fs.writeFileSync(jsonFile(id), JSON.stringify(meta));
    j.state = 'done';
  }

  /** what the TV app gets: the grid description + how many sheets can already be downloaded. */
  function info(id) {
    const j = jobs.get(id);
    const meta = readJson(id);
    if (!meta) return { state: j ? j.state : 'none', error: j && j.error };
    let ready = meta.sheets;
    if (!meta.done) {   // while ffmpeg runs, the newest file may still be written to
      let n = 0;
      while (fs.existsSync(sheetFile(id, n + 1))) n++;
      ready = fs.existsSync(sheetFile(id, 0)) ? n : 0;
    }
    if (!meta.done && ready === 0) return { state: j ? j.state : 'queued' };
    const { srcSize, srcMtime, ...pub } = meta;
    return { state: meta.done ? 'done' : 'working', ...pub, ready };
  }

  function sheetPath(id, n) {
    if (!Number.isInteger(n) || n < 0) return null;
    const f = sheetFile(id, n);
    return fs.existsSync(f) ? f : null;
  }

  return { enqueue, prioritize, info, sheetPath, INTERVAL };
};
