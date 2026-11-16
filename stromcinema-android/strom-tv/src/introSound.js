// The start-up sound is synthesised with Web Audio (no audio file): a rising whoosh, a deep impact, a soft
// shimmering chord and a bright "ting" when the light sweeps across the logo. About 3.3 seconds in total.
let played = false;

export function playIntroSound() {
  if (played) return null;
  played = true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  let ctx;
  try { ctx = new AC(); } catch { return null; }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const t0 = ctx.currentTime + 0.08;

  const master = ctx.createGain(); master.gain.value = 0.55;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6;
  master.connect(comp); comp.connect(ctx.destination);

  const env = (g, at, peak, attack, hold, release) => {
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(peak, t0 + at + attack);
    g.gain.setValueAtTime(peak, t0 + at + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + attack + hold + release);
  };
  const tone = (type, freq, at, peak, attack, hold, release, toFreq) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0 + at);
    if (toFreq) o.frequency.exponentialRampToValueAtTime(toFreq, t0 + at + attack + hold + release);
    env(g, at, peak, attack, hold, release);
    o.connect(g); g.connect(master);
    o.start(t0 + at); o.stop(t0 + at + attack + hold + release + 0.1);
  };

  // rising whoosh (filtered noise), 0.15 -> 0.6 s
  const len = Math.floor(ctx.sampleRate * 1.2), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource(); noise.buffer = buf;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(180, t0 + 0.15); bp.frequency.exponentialRampToValueAtTime(3200, t0 + 0.62);
  const ng = ctx.createGain(); env(ng, 0.15, 0.32, 0.4, 0.02, 0.35);
  noise.connect(bp); bp.connect(ng); ng.connect(master); noise.start(t0 + 0.15); noise.stop(t0 + 1.4);

  // impact at 0.6 s: deep sine drop + a short low thump
  tone('sine', 150, 0.6, 0.95, 0.01, 0.05, 1.3, 36);
  tone('triangle', 70, 0.6, 0.35, 0.01, 0.03, 0.5, 40);

  // soft chord (D major add 9) swelling in after the hit
  [[146.83, 0.10], [220, 0.075], [293.66, 0.07], [369.99, 0.055], [440, 0.05], [659.25, 0.03]].forEach(([f, v], i) => {
    tone('sine', f, 0.62 + i * 0.04, v, 0.5, 0.9, 1.6);
    tone('triangle', f * 1.003, 0.62 + i * 0.04, v * 0.35, 0.5, 0.9, 1.6);
  });

  // bright "ting" while the light sweeps the name (about 1.9 s)
  tone('sine', 1760, 1.9, 0.07, 0.01, 0.02, 1.1);
  tone('sine', 2637, 1.92, 0.045, 0.01, 0.02, 1.0);

  const closeCtx = () => { try { if (ctx.state !== 'closed') ctx.close().catch(() => {}); } catch { /* ignore */ } };
  const stop = () => {
    try { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.06); } catch { /* ignore */ }
    setTimeout(() => closeCtx(), 400);
  };
  setTimeout(() => closeCtx(), 6000);
  return stop;
}
