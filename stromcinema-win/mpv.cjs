// Plays a film with mpv (fullscreen, its own on-screen controls) and reports the position back to the server.
// mpv decodes nearly every format (HEVC, DTS, TrueHD, Atmos ...) and can use the graphics chip for it.
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXE = process.platform === 'win32' ? 'mpv.exe' : 'mpv';

function findMpv(configured, dirs) {
  const list = [];
  if (configured) list.push(configured, path.join(configured, EXE));
  for (const d of dirs) list.push(path.join(d, 'mpv', EXE), path.join(d, EXE));
  for (const c of list) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
  return null;
}

function createPlayer({ getConfig, dataDir, searchDirs }) {
  const confFile = path.join(dataDir, 'mpv-input.conf');

  function play({ url, title, startTimeMs, movieId, progressUrl, preferredAudio, preferredSubtitle, audioIndex, subtitleIndex, subtitleOff, subUrl, subEmbCount }) {
    return new Promise((resolve, reject) => {
      const cfg = getConfig() || {};
      const mpvPath = findMpv(cfg.mpvPath, searchDirs) || EXE; // last resort: whatever "mpv" is on the PATH

      // a local file is played straight from disk (faster and seeks better than HTTP)
      let target = url;
      try { const p = new URL(url).searchParams.get('path'); if (p && fs.existsSync(p)) target = p; } catch { /* keep url */ }

      // Esc / Backspace leave the film, like Back on the TV remote
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(confFile, 'ESC quit\nBS quit\nq quit\nMEDIA_STOP quit\nENTER cycle pause\n');

      const pipeName = `strom-mpv-${process.pid}-${Date.now()}`;
      const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : path.join(os.tmpdir(), pipeName + '.sock');
      const args = [
        '--fs', `--input-ipc-server=${pipe}`, '--force-window=immediate', `--force-media-title=${title || ''}`,
        '--hwdec=auto-safe', '--keep-open=no', '--save-position-on-quit=no', `--input-conf=${confFile}`, '--cursor-autohide=1500',
      ];
      if (startTimeMs > 0) args.push(`--start=${(startTimeMs / 1000).toFixed(3)}`);
      // audio / subtitle: what the viewer picked on the shelf, else the server's language defaults.
      // mpv numbers tracks from 1 in file order; a subtitle file loaded with --sub-file comes after the film's own ones.
      const lang3 = (x) => (/^[a-z]{3}$/.test(x || '') && x !== 'off' && x !== 'any' ? x : '');
      if (Number.isInteger(audioIndex) && audioIndex >= 0) args.push(`--aid=${audioIndex + 1}`);
      else if (lang3(preferredAudio) && preferredAudio !== 'any') args.push(`--alang=${preferredAudio}`);
      if (typeof subUrl === 'string' && /^https?:\/\//i.test(subUrl)) args.push(`--sub-file=${subUrl}`, `--sid=${(Number(subEmbCount) || 0) + 1}`);
      else if (Number.isInteger(subtitleIndex) && subtitleIndex >= 0) args.push(`--sid=${subtitleIndex + 1}`);
      else if (subtitleOff) args.push('--sid=no');
      else if (lang3(preferredSubtitle)) args.push(`--slang=${preferredSubtitle}`);
      else args.push('--sid=no');
      if (cfg.passthrough) args.push('--audio-spdif=ac3,eac3,dts,dts-hd,truehd', '--audio-exclusive=yes');
      args.push('--', target);

      let child;
      try { child = spawn(mpvPath, args, { stdio: 'ignore' }); } catch (e) { reject(e); return; }

      let posSec = 0, durSec = 0, finished = false, socket = null, lastPost = 0, retry = null;
      const post = () => {
        if (!progressUrl || !movieId || !(posSec > 0)) return;
        fetch(progressUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: movieId, positionMs: Math.round(posSec * 1000), durationMs: Math.round(durSec * 1000) }) }).catch(() => {});
      };
      const connect = (tries) => {
        if (finished) return;
        const s = net.createConnection(pipe);
        let buf = '';
        s.on('connect', () => {
          socket = s;
          s.write(JSON.stringify({ command: ['observe_property', 1, 'time-pos'] }) + '\n');
          s.write(JSON.stringify({ command: ['observe_property', 2, 'duration'] }) + '\n');
        });
        s.on('data', (d) => {
          buf += d.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            let m; try { m = JSON.parse(line); } catch { continue; }
            if (m.event === 'property-change' && typeof m.data === 'number') {
              if (m.name === 'time-pos') { posSec = m.data; if (Date.now() - lastPost > 10000) { lastPost = Date.now(); post(); } }
              else if (m.name === 'duration') durSec = m.data;
            }
          }
        });
        s.on('error', () => { if (!socket && tries > 0 && !finished) retry = setTimeout(() => connect(tries - 1), 200); });
      };
      connect(50); // mpv needs a moment before its pipe exists

      child.on('error', (e) => { if (finished) return; finished = true; clearTimeout(retry); reject(new Error(e.code === 'ENOENT' ? 'mpv-not-found' : e.message)); });
      child.on('close', () => {
        if (finished) return;
        finished = true; clearTimeout(retry);
        if (socket) socket.destroy();
        post();
        resolve({ positionMs: Math.round(posSec * 1000), durationMs: Math.round(durSec * 1000) });
      });
    });
  }
  return { play, findMpv: () => findMpv((getConfig() || {}).mpvPath, searchDirs) };
}

module.exports = { createPlayer, findMpv };
