// One place for remote-control / keyboard input. Screens register a handler with useInput();
// only the top-most screen receives keys. Names: left right up down enter playpause back backspace char.
import { useEffect, useRef } from 'react';

const stack = [];
let lastBack = 0;

const NAMES = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  Enter: 'enter', MediaPlayPause: 'playpause', MediaPlay: 'playpause',
  Escape: 'back', GoBack: 'back', BrowserBack: 'back', Backspace: 'backspace',
};

function nameOf(e) {
  if (NAMES[e.key]) return NAMES[e.key];
  switch (e.keyCode) {
    case 13: case 23: case 66: return 'enter';       // Enter / DPAD_CENTER
    case 85: case 126: case 127: return 'playpause';  // media keys
    case 4: return 'back';
    default: break;
  }
  if (e.key === ' ') return 'enter';
  if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return 'char';
  return null;
}

let block = null;
export function setInputBlock(fn) { block = fn; } // while set, every key goes only to fn (used by the start-up intro)

export function dispatchInput(name, e) {
  if (block) { block(name); return true; }
  const top = stack[stack.length - 1];
  if (!top) return false;
  if (name === 'back') {
    const t = Date.now();
    if (t - lastBack < 250) return true; // Capacitor's backButton and a key event can both fire
    lastBack = t;
  }
  return !!top.current(name, e || {});
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    const name = nameOf(e);
    if (!name) return;
    if (e.repeat && (name === 'enter' || name === 'playpause' || name === 'back')) { e.preventDefault(); return; }
    if (dispatchInput(name, e)) e.preventDefault();
  }, true);
}

export function useInput(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    stack.push(ref);
    return () => { const i = stack.lastIndexOf(ref); if (i >= 0) stack.splice(i, 1); };
  }, []);
}
