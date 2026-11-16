// Desktop-browser stand-in for the native StromPlayer plugin (development only; never used on the TV).
import { WebPlugin } from '@capacitor/core';

const KEY = 'strom_server';

export class StromPlayerWeb extends WebPlugin {
  async getServer() { try { return { host: localStorage.getItem(KEY) || '' }; } catch { return { host: '' }; } }
  async setServer({ host }) { try { localStorage.setItem(KEY, host || ''); } catch { /* ignore */ } }
  async clearServer() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
  async discoverServer() { throw this.unavailable('mDNS needs the Android app'); }
  async getLocalIp() { return { ip: '' }; }
  async getAudioSupport() { return {}; }
  async openYouTube({ key }) { window.open('https://www.youtube.com/watch?v=' + encodeURIComponent(key), '_blank'); }

  play({ url, title, startTimeMs, movieId, progressUrl }) {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.className = 'dev-player';
      box.innerHTML = '<div class="dev-player-bar"><b></b><span>Esc to close — desktop preview only, the TV uses ExoPlayer</span></div><video controls autoplay></video>';
      box.querySelector('b').textContent = title || '';
      const video = box.querySelector('video');
      video.src = url;
      if (startTimeMs > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = startTimeMs / 1000; }, { once: true });
      let last = 0;
      const report = () => {
        if (!progressUrl || !movieId || !(video.currentTime > 0)) return;
        fetch(progressUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: movieId, positionMs: Math.round(video.currentTime * 1000), durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0 }) }).catch(() => {});
      };
      video.addEventListener('timeupdate', () => { if (Date.now() - last > 10000) { last = Date.now(); report(); } });
      const close = () => {
        report();
        const result = { positionMs: Math.round(video.currentTime * 1000), durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0 };
        window.removeEventListener('keydown', onKey, true);
        video.pause(); video.removeAttribute('src'); box.remove();
        resolve(result);
      };
      const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); close(); } };
      window.addEventListener('keydown', onKey, true);
      video.addEventListener('ended', close);
      document.body.appendChild(box);
    });
  }
}
