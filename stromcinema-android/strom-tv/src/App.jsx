import React, { useState } from 'react';
import Gate from './Gate.jsx';
import Library from './Library.jsx';
import Intro from './Intro.jsx';
import { getSavedServer, forgetServer, exitApp, openSettings, isDesktop } from './native.js';
import { consumeReturning, loadLibCache } from './session.js';
import { dlog } from './debug.js';

function introMode() { try { return localStorage.getItem('strom_intro') || 'on'; } catch { return 'on'; } }

// Android can close the app while a film plays (the player uses a lot of memory). When we come back from a film like that,
// skip the intro and go straight to the shelf (shown from the saved copy) instead of starting from scratch.
const RETURNED = consumeReturning();            // ms since the film was started, or null on a normal start
const SAVED = loadLibCache();
const BACK_TO_SHELF = RETURNED !== null && !!SAVED;
dlog('app', RETURNED !== null ? `START after a film (${Math.round(RETURNED / 1000)} s ago): the app was restarted while it played${SAVED ? '' : ' (no saved library)'}` : 'START (normal launch)');
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => dlog('app', document.hidden ? 'went to the background' : 'back in front'));

export default function App() {
  const [mode] = useState(introMode);            // 'on' | 'silent' | 'off' (from the server setting, remembered here)
  const [intro, setIntro] = useState(mode !== 'off' && RETURNED === null);
  const [introFading, setIntroFading] = useState(false);   // the shelf starts loading when the intro begins to fade out, not before
  // screen: 'gate' (find / connect to the server) or 'library' (the shelf)
  const [screen, setScreen] = useState(BACK_TO_SHELF ? 'library' : 'gate');
  const [host, setHost] = useState(BACK_TO_SHELF ? SAVED.host : '');
  const [gateKey, setGateKey] = useState(0);
  const [skipSaved, setSkipSaved] = useState(false);

  const body = screen === 'library' ? (
    <Library
      host={host}
      onChangeServer={isDesktop ? openSettings : async () => { await forgetServer(); setSkipSaved(true); setGateKey((k) => k + 1); setScreen('gate'); }}
      onLostServer={() => { setSkipSaved(false); setGateKey((k) => k + 1); setScreen('gate'); }}
      onExit={exitApp}
    />
  ) : (
    <Gate
    key={gateKey}
    loadSaved={skipSaved ? async () => '' : getSavedServer}
    onConnected={(h) => { setHost(h); setScreen('library'); }}
    onExit={exitApp}
  />
  );
  return <>{(!intro || introFading) && body}{intro && <Intro silent={mode === 'silent'} onLeave={() => setIntroFading(true)} onDone={() => setIntro(false)} />}</>;
}
