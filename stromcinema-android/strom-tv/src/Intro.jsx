import React, { useEffect, useRef, useState } from 'react';
import { playIntroSound } from './introSound.js';
import { setInputBlock } from './input.js';

const TOTAL = 3300;   // ms until the intro is gone
const FADE = 500;     // last part is a fade-out

export default function Intro({ silent, onDone, onLeave }) {
  const [leaving, setLeaving] = useState(false);
  const stopRef = useRef(null);
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (stopRef.current) stopRef.current();
    setLeaving(true);
    if (onLeave) onLeave();
    setTimeout(onDone, 250);
  };

  useEffect(() => {
    if (!silent) stopRef.current = playIntroSound();
    setInputBlock(() => finish());                       // any remote / keyboard key skips the intro
    const t1 = setTimeout(() => { setLeaving(true); if (onLeave) onLeave(); }, TOTAL - FADE);
    const t2 = setTimeout(() => { if (!doneRef.current) { doneRef.current = true; onDone(); } }, TOTAL);
    return () => { clearTimeout(t1); clearTimeout(t2); setInputBlock(null); };
  }, []);

  return (
    <div className={`intro ${leaving ? 'leaving' : ''}`} onClick={finish} aria-hidden="true">
      <div className="intro-glow" />
      <div className="intro-ring" /><div className="intro-ring r2" />
      <div className="intro-stage">
        <div className="intro-mark">S</div>
        <div className="intro-word">{'STRØM'.split('').map((c, i) => <span key={i} style={{ '--i': i }}>{c}</span>)}<i className="intro-shine" /></div>
        <div className="intro-sub">YOUR MOVIES · YOUR SHELF</div>
      </div>
    </div>
  );
}
