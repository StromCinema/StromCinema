// Strøm server (slim): serves your movie files and the TV/desktop app's API. No torrents.
// Run it on its own:   node strom-server.cjs
// Or start it from another program (the desktop app):   require('./strom-server.cjs').start({ dataDir, webDir })
// Settings live in strom-config.json inside dataDir (an existing plexus-config.json is picked up automatically).
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.ts': 'video/mp2t' };
const norm = (p) => path.resolve(p).toLowerCase();

function start(opts = {}) {
  const dataDir = opts.dataDir || __dirname;
  const wantedPort = opts.port !== undefined ? opts.port : (Number(process.env.PORT) || 5000);
  fs.mkdirSync(dataDir, { recursive: true });
  const newFile = path.join(dataDir, 'strom-config.json');
  const oldFile = path.join(dataDir, 'plexus-config.json');
  const CONFIG_FILE = fs.existsSync(newFile) || !fs.existsSync(oldFile) ? newFile : oldFile;

  function loadConfig() {
    try { if (fs.existsSync(CONFIG_FILE)) return { libraryPaths: [], tmdbApiKey: '', ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
    catch (e) { console.warn('[Strøm] Could not read', path.basename(CONFIG_FILE), '-', e.message); }
    return { libraryPaths: [], tmdbApiKey: '' };
  }
  const config = loadConfig();
  const saveConfig = () => { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8'); } catch (e) { console.warn('[Strøm] Could not save config:', e.message); } };
  console.log(`[Strøm] Settings file: ${CONFIG_FILE}`);

  const app = express();
  let port = wantedPort;
  app.use(cors({ origin: '*', exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'], allowedHeaders: ['Range', 'Content-Type'] }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/ping', (req, res) => res.json({ service: 'strom', port }));

  const folders = () => (config.libraryPaths || []).map((e) => (typeof e === 'string' ? { path: e, category: 'Movies' } : e)).filter((e) => e && e.path);

  // ---- streaming (HTTP Range, so the player can seek). Only files inside your library folders are served. ----
  function insideLibrary(file) {
    const f = norm(file);
    return folders().some((e) => { const r = norm(e.path); return f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep); });
  }
  function handleStream(req, res, sendBody) {
    const file = req.query.path;
    if (!file || typeof file !== 'string' || !insideLibrary(file) || !fs.existsSync(file)) return res.status(404).send('Not found');
    let size; try { size = fs.statSync(file).size; } catch { return res.status(500).send('Stat failed'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    let begin = 0, end = size - 1, status = 200;
    if (req.headers.range) {
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      if (m) {
        if (m[1] !== '') { begin = parseInt(m[1], 10); end = m[2] !== '' ? Math.min(parseInt(m[2], 10), size - 1) : size - 1; }
        else if (m[2] !== '') { begin = Math.max(0, size - parseInt(m[2], 10)); }
        if (!(begin >= 0 && begin < size && begin <= end)) return res.status(416).set('Content-Range', `bytes */${size}`).end();
        status = 206;
      }
    }
    const headers = { 'Content-Length': end - begin + 1, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (status === 206) headers['Content-Range'] = `bytes ${begin}-${end}/${size}`;
    res.writeHead(status, headers);
    if (!sendBody || size === 0) return res.end();
    const rs = fs.createReadStream(file, { start: begin, end });
    rs.on('error', () => res.end());
    req.on('close', () => rs.destroy());
    rs.pipe(res);
  }
  app.get('/api/stream', (req, res) => handleStream(req, res, true));
  app.head('/api/stream', (req, res) => handleStream(req, res, false));

  // ---- the app's API (library, covers, progress, shelf settings) ----
  require('./tv-api.cjs')(app, { getConfig: () => config, saveConfig, baseDir: dataDir, axios });

  // ---- tiny setup page: http://<this-pc>:5000/setup ----
  app.get('/api/setup', (req, res) => res.json({ folders: folders(), tmdbApiKey: config.tmdbApiKey || '', passthrough: !!config.passthrough, serverOnly: !!config.serverOnly, mpvPath: config.mpvPath || '' }));
  app.post('/api/setup', (req, res) => {
    const b = req.body || {};
    if (Array.isArray(b.folders)) {
      config.libraryPaths = b.folders
        .map((f) => (typeof f === 'string' ? { path: f, category: 'Movies' } : f))
        .filter((f) => f && String(f.path || '').trim())
        .map((f) => ({ path: String(f.path).trim(), category: /tv|serie|show/i.test(f.category || '') ? 'TV Shows' : 'Movies' }));
    }
    if (typeof b.tmdbApiKey === 'string') config.tmdbApiKey = b.tmdbApiKey.trim();
    if (typeof b.passthrough === 'boolean') config.passthrough = b.passthrough;
    if (typeof b.serverOnly === 'boolean') config.serverOnly = b.serverOnly;
    if (typeof b.mpvPath === 'string') config.mpvPath = b.mpvPath.trim();
    saveConfig();
    res.json({ ok: true });
  });
  app.get('/setup', (req, res) => res.type('html').send(SETUP_HTML));

  // ---- the web app itself (desktop mode) ----
  if (opts.webDir) {
    app.use(express.static(opts.webDir));
    app.get('*', (req, res, next) => (req.path.startsWith('/api/') ? next() : res.sendFile(path.join(opts.webDir, 'index.html'))));
  }

  return new Promise((resolve, reject) => {
    let bonjour = null;
    const server = app.listen(wantedPort, '0.0.0.0');
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && opts.portFallback) { console.warn(`[Strøm] port ${wantedPort} is busy, using another one`); server.listen(0, '0.0.0.0'); }
      else reject(e);
    });
    server.on('listening', () => {
      port = server.address().port;
      const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
      console.log(`\n[Strøm] Server running on port ${port}`);
      ips.forEach((ip) => console.log(`[Strøm]   TV address:  ${ip}:${port}`));
      console.log(`[Strøm]   Setup page:  http://localhost:${port}/setup\n`);
      // let the TV find the server automatically (mDNS)
      if (process.env.DISABLE_MDNS !== '1' && opts.mdns !== false) {
        try {
          const { Bonjour } = require('bonjour-service');
          bonjour = new Bonjour();
          bonjour.publish({ name: `Strøm-${os.hostname()}`, type: 'strom', port });
        } catch (e) { console.warn('[Strøm] mDNS not available:', e.message); }
      }
      const close = () => new Promise((done) => {
        const fin = () => server.close(() => done());
        if (bonjour) bonjour.unpublishAll(() => { bonjour.destroy(); fin(); }); else fin();
        if (server.closeAllConnections) server.closeAllConnections();
      });
      resolve({ port, close, getConfig: () => config });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then((s) => {
    const bye = () => s.close().then(() => process.exit(0));
    process.on('SIGINT', bye); process.on('SIGTERM', bye);
  }).catch((e) => { console.error('[Strøm] Could not start:', e.message); process.exit(1); });
}

const SETUP_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Strøm setup</title>
<style>body{font:16px system-ui,sans-serif;background:#0c0918;color:#f5f0ff;max-width:680px;margin:40px auto;padding:0 20px}h1{font-size:28px}label{display:block;margin:22px 0 6px;font-weight:600}
textarea,input,select{width:100%;padding:10px;border-radius:8px;border:1px solid #4a3d7a;background:#171129;color:inherit;font:inherit}textarea{height:110px}
small{color:#9b91b5}button{margin-top:24px;padding:12px 26px;border:0;border-radius:8px;background:#6c48ec;color:#fff;font:inherit;font-weight:700;cursor:pointer}
.frow{display:grid;grid-template-columns:1fr 150px 44px;gap:8px;margin-bottom:8px}.frow button{margin:0;padding:0;background:#3a2a5a}.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}#msg{margin-left:14px;color:#9fe3a0}</style></head><body>
<a id="back" href="/" style="display:none;color:#b9a8ff">← Back to library</a>
<h1>Strøm setup</h1>
<label>Media folders <small>(pick Movies or TV series for each folder)</small></label><div id="folders"></div><button id="add" type="button" style="margin-top:10px;background:#2a2050">+ Add folder</button>
<label>TMDB API key or token <small>(for covers)</small></label><input id="tmdb" type="password" autocomplete="off">
<div id="desk" style="display:none"><h1 style="margin-top:34px;font-size:20px">Desktop player (mpv)</h1>
<div class="row"><div><label>Sound passthrough <small>(DTS / Dolby to a receiver)</small></label><select id="passthrough"><option value="off">Off (decode on this PC)</option><option value="on">On (send to receiver)</option></select></div>
<div><label>mpv location <small>(optional)</small></label><input id="mpvPath" placeholder="auto: the mpv folder next to Strom.exe"></div></div>
<div class="row"><div><label>Next startup <small>(takes effect when Strøm is started again)</small></label><select id="serverOnly"><option value="off">Open the shelf on this PC</option><option value="on">Run as server only (tray icon, no window)</option></select></div><div></div></div></div>
<h1 style="margin-top:34px;font-size:20px">Shelf look</h1>
<div class="row"><div><label>Layout</label><select id="pose"><option value="fan">Fan</option><option value="shelf">Shelf</option><option value="grid">Grid (posters)</option></select></div>
<div><label>Cover fit</label><select id="fit"><option value="fill">Fill</option><option value="fit">Fit</option><option value="stretch">Stretch</option></select></div>
<div><label>Sort</label><select id="sort"><option value="title">Title</option><option value="added">Recently added</option></select></div>
<div><label>Background colour</label><select id="background"><option value="purple">Purple (default)</option><option value="blue">Blue</option><option value="teal">Teal</option><option value="green">Green</option><option value="wine">Wine red</option><option value="charcoal">Charcoal</option><option value="black">Black</option><option value="custom">Custom…</option></select><input id="bgcustom" type="color" value="#25134e" style="display:none;margin-top:8px;height:44px;padding:2px"></div><div><label>Animation quality</label><select id="quality"><option value="smooth">Smooth (recommended)</option><option value="full">Full (all reflections)</option></select></div><div><label>Preferred audio language</label><select id="preferredAudio"><option value="any">No preference</option><option value="eng">English</option><option value="swe">Swedish</option><option value="nor">Norwegian</option><option value="dan">Danish</option><option value="fin">Finnish</option><option value="ger">German</option><option value="fre">French</option><option value="spa">Spanish</option><option value="ita">Italian</option><option value="dut">Dutch</option><option value="por">Portuguese</option><option value="pol">Polish</option><option value="rus">Russian</option><option value="jpn">Japanese</option><option value="kor">Korean</option><option value="chi">Chinese</option></select></div><div><label>Subtitles by default</label><select id="preferredSubtitle"><option value="off">Off (viewer picks)</option><option value="eng">English</option><option value="swe">Swedish</option><option value="nor">Norwegian</option><option value="dan">Danish</option><option value="fin">Finnish</option><option value="ger">German</option><option value="fre">French</option><option value="spa">Spanish</option><option value="ita">Italian</option><option value="dut">Dutch</option><option value="por">Portuguese</option><option value="pol">Polish</option><option value="rus">Russian</option><option value="jpn">Japanese</option><option value="kor">Korean</option><option value="chi">Chinese</option></select></div><div><label>Convert TrueHD/DTS audio for Android TV</label><select id="audioConvert"><option value="auto">Auto (only if the TV cannot play it)</option><option value="on">Always</option><option value="off">Off</option></select></div><div><label>Start-up intro</label><select id="intro"><option value="on">On (with sound)</option><option value="silent">On, silent</option><option value="off">Off</option></select></div><div><label>Cover language</label><select id="language"><option value="sv-SE">Svenska (sv-SE)</option><option value="en-US">English (US) (en-US)</option><option value="en-GB">English (UK) (en-GB)</option><option value="nb-NO">Norsk (nb-NO)</option><option value="da-DK">Dansk (da-DK)</option><option value="fi-FI">Suomi (fi-FI)</option><option value="de-DE">Deutsch (de-DE)</option><option value="fr-FR">Français (fr-FR)</option><option value="es-ES">Español (es-ES)</option><option value="it-IT">Italiano (it-IT)</option><option value="nl-NL">Nederlands (nl-NL)</option><option value="pt-PT">Português (pt-PT)</option><option value="pl-PL">Polski (pl-PL)</option><option value="ru-RU">Русский (ru-RU)</option><option value="ja-JP">日本語 (ja-JP)</option><option value="ko-KR">한국어 (ko-KR)</option><option value="zh-CN">中文 (zh-CN)</option></select></div>
<div><label>Corner rounding (0–12)</label><input id="round" type="number" min="0" max="12" step="0.1"></div>
<div><label>Animation speed (0.35–1.2)</label><input id="speed" type="number" min="0.35" max="1.2" step="0.05"></div></div>
<button id="save">Save</button><span id="msg"></span>
<script>
const $=i=>document.getElementById(i);
const addRow=(p,c)=>{const d=document.createElement('div');d.className='frow';d.innerHTML='<input placeholder="D:\\\\Movies"><select><option value="Movies">Movies</option><option value="TV Shows">TV series</option></select><button type="button">✕</button>'+(window.stromDesktop?'<button type="button" class="br">Browse…</button>':'');d.children[0].value=p||'';d.children[1].value=/tv|serie|show/i.test(c||'')?'TV Shows':'Movies';d.children[2].onclick=()=>d.remove();if(d.children[3]){d.style.gridTemplateColumns='1fr 150px 44px 100px';d.children[3].onclick=async()=>{const p=await window.stromDesktop.pickFolder();if(p)d.children[0].value=p;};}$('folders').appendChild(d);};
$('add').onclick=()=>addRow('','Movies');
$('background').onchange=()=>{$('bgcustom').style.display=$('background').value==='custom'?'block':'none';};
if(window.stromDesktop){$('desk').style.display='block';$('back').style.display='inline';}
(async()=>{const s=await (await fetch('/api/setup')).json();$('passthrough').value=s.passthrough?'on':'off';$('serverOnly').value=s.serverOnly?'on':'off';$('mpvPath').value=s.mpvPath||'';s.folders.forEach(f=>addRow(f.path,f.category));if(!s.folders.length)addRow('','Movies');$('tmdb').value=s.tmdbApiKey;
const t=(await (await fetch('/api/tv/settings')).json());const v=t.settings||t;if(/^#/.test(v.background||'')){$('background').value='custom';$('bgcustom').value=v.background;$('bgcustom').style.display='block';v.background=undefined;}if(v.language&&![...$('language').options].some(o=>o.value===v.language))$('language').add(new Option(v.language,v.language));for(const k of ['pose','fit','sort','language','round','speed','quality','background','intro','audioConvert','preferredAudio','preferredSubtitle'])if(v[k]!==undefined)$(k).value=v[k];})();
$('save').onclick=async()=>{const J={method:'POST',headers:{'Content-Type':'application/json'}};
await fetch('/api/setup',{...J,body:JSON.stringify({folders:[...document.querySelectorAll('.frow')].map(d=>({path:d.children[0].value,category:d.children[1].value})),tmdbApiKey:$('tmdb').value,passthrough:$('passthrough').value==='on',serverOnly:$('serverOnly').value==='on',mpvPath:$('mpvPath').value})});
await fetch('/api/tv/settings',{...J,body:JSON.stringify({pose:$('pose').value,fit:$('fit').value,sort:$('sort').value,language:$('language').value,quality:$('quality').value,intro:$('intro').value,audioConvert:$('audioConvert').value,preferredAudio:$('preferredAudio').value,preferredSubtitle:$('preferredSubtitle').value,background:$('background').value==='custom'?$('bgcustom').value:$('background').value,round:Number($('round').value),speed:Number($('speed').value)})});
await fetch('/api/tv/refresh',{method:'POST'});$('msg').textContent=window.stromDesktop?'Saved.':'Saved. Restart the TV app or press OK to refresh.';};
</script></body></html>`;
