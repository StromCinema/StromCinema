import React, { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeHost, ping, scanSubnet } from './api.js';
import { discoverServer, getLocalIp, saveServer } from './native.js';
import { useInput } from './input.js';

const KEYS = [
  ['1', '2', '3', 'back'],
  ['4', '5', '6', '.'],
  ['7', '8', '9', ':'],
  ['cancel', '0', 'go', 'go'],
];
const LABEL = { back: '⌫', cancel: 'Cancel', go: 'Connect' };

export default function Gate({ loadSaved, onConnected, onExit }) {
  // mode: connecting | searching | failed | manual
  const [mode, setMode] = useState('connecting');
  const [host, setHost] = useState('');          // the address being tried / that failed
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState(null);
  const [label, setLabel] = useState('');
  const [focus, setFocus] = useState(0);         // button index (connecting/failed)
  const [pad, setPad] = useState({ r: 3, c: 2 }); // keypad focus
  const [text, setText] = useState('');
  const token = useRef(0);

  const cancel = () => { token.current++; };
  useEffect(() => () => { token.current++; }, []);

  const finish = useCallback(async (h) => {
    await saveServer(h);
    onConnected(h);
  }, [onConnected]);

  const tryHost = useCallback(async (h, failMessage) => {
    const t = ++token.current;
    setHost(h); setMode('connecting'); setFocus(0);
    const ok = await ping(h, 3000);
    if (t !== token.current) return;
    if (ok) finish(h);
    else { setMessage(failMessage || `No Strøm server answered at ${h}.`); setMode('failed'); setFocus(0); }
  }, [finish]);

  const search = useCallback(async () => {
    const t = ++token.current;
    const alive = () => t === token.current;
    setHost(''); setMode('searching'); setProgress(null); setLabel('Looking for your Strøm server…'); setFocus(0);
    const found = await discoverServer();
    if (!alive()) return;
    if (found && await ping(found, 2500)) { if (alive()) finish(found); return; }
    const ip = await getLocalIp();
    if (!alive()) return;
    if (ip) {
      const prefix = ip.split('.').slice(0, 3).join('.');
      setLabel(`Scanning ${prefix}.1 – ${prefix}.254 …`); setProgress(0);
      const h = await scanSubnet(ip, { onProgress: (p) => alive() && setProgress(p), alive });
      if (!alive()) return;
      if (h) { finish(h); return; }
    }
    setMessage('No Strøm server was found on this network.'); setMode('failed'); setFocus(0);
  }, [finish]);

  // Start: the saved server first, otherwise look around.
  useEffect(() => {
    let dead = false;
    (async () => {
      const saved = await loadSaved();
      if (dead) return;
      if (saved) tryHost(saved); else search();
    })();
    return () => { dead = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openManual = (prefill = '') => { cancel(); setText(prefill.replace(/:5000$/, '')); setPad({ r: 3, c: 2 }); setMessage(''); setMode('manual'); };

  const buttons = mode === 'failed'
    ? [
        ...(host ? [{ id: 'retry', text: 'Try again', run: () => tryHost(host) }] : []),
        { id: 'search', text: 'Search network', run: search },
        { id: 'manual', text: 'Enter address', run: () => openManual(host) },
        { id: 'exit', text: 'Exit', run: onExit },
      ]
    : mode === 'connecting' || mode === 'searching'
      ? [{ id: 'stop', text: 'Stop', run: () => { cancel(); setMessage(''); setMode('failed'); setFocus(0); } }]
      : [];

  const press = (key) => {
    if (key === 'back') setText((s) => s.slice(0, -1));
    else if (key === 'cancel') { cancel(); setMessage(''); setMode('failed'); setFocus(0); }
    else if (key === 'go') {
      const h = normalizeHost(text);
      if (!h) { setMessage('That does not look like an address. Example: 192.168.1.20'); return; }
      setMessage(''); tryHost(h, `No Strøm server answered at ${h}. Check the address and that the server is running.`);
    } else setText((s) => (s.length < 24 ? s + key : s));
  };

  useInput((name, e) => {
    if (mode === 'manual') {
      if (name === 'left') setPad((p) => ({ ...p, c: Math.max(0, p.c - 1) }));
      else if (name === 'right') setPad((p) => ({ ...p, c: Math.min(3, p.c + 1) }));
      else if (name === 'up') setPad((p) => ({ ...p, r: Math.max(0, p.r - 1) }));
      else if (name === 'down') setPad((p) => ({ ...p, r: Math.min(3, p.r + 1) }));
      else if (name === 'enter') { if (e && e.key && e.key.length === 1 && e.key !== ' ') { /* typed space */ } press(KEYS[pad.r][pad.c]); }
      else if (name === 'back') press('cancel');
      else if (name === 'backspace') press('back');
      else if (name === 'char' && /^[0-9.:]$/.test(e.key)) press(e.key);
      else return false;
      return true;
    }
    if (name === 'left' || name === 'up') setFocus((f) => Math.max(0, f - 1));
    else if (name === 'right' || name === 'down') setFocus((f) => Math.min(buttons.length - 1, f + 1));
    else if (name === 'enter') { const b = buttons[Math.min(focus, buttons.length - 1)]; if (b) b.run(); }
    else if (name === 'back') { if (mode === 'failed') onExit(); else { cancel(); setMode('failed'); setFocus(0); } }
    else return false;
    return true;
  });

  return (
    <main className="gate">
      <div className="gate-brand"><span className="brand-mark">S</span><span>STRØM</span></div>

      {mode === 'manual' ? (
        <section className="gate-card">
          <h1>Server address</h1>
          <div className="addr" aria-live="polite">
            <span>{text || <i>192.168.1.20</i>}</span><u className="caret" />
          </div>
          <p className="gate-note">{message || 'Type the IP address of the computer running Strøm. Port 5000 is used if you leave it out.'}</p>
          <div className="keypad">
            {KEYS.flatMap((row, r) => row.map((k, c) => {
              if (k === 'go' && c === 3) return null;
              const on = pad.r === r && (pad.c === c || (k === 'go' && pad.c === 3));
              return (
                <button key={`${r}-${c}`} tabIndex={-1}
                  className={`key ${k === 'go' ? 'key-go' : ''} ${on ? 'is-focus' : ''}`}
                  onClick={() => { setPad({ r, c }); press(k); }}>{LABEL[k] || k}</button>
              );
            }))}
          </div>
        </section>
      ) : (
        <section className="gate-card">
          {mode === 'failed' ? (
            <>
              <h1>Can’t find your server</h1>
              <p className="gate-note">{message}</p>
              <p className="gate-note dim">Make sure the Strøm server is running and that this TV is on the same network.</p>
            </>
          ) : (
            <>
              <h1>{mode === 'connecting' ? 'Connecting…' : 'Searching…'}</h1>
              <p className="gate-note">{mode === 'connecting' ? host : label}</p>
              <div className={`bar ${progress === null ? 'indeterminate' : ''}`}><i style={progress === null ? undefined : { width: `${Math.round(progress * 100)}%` }} /></div>
            </>
          )}
          <div className="gate-actions">
            {buttons.map((b, i) => (
              <button key={b.id} tabIndex={-1} className={`btn ${i === focus ? 'is-focus' : ''}`} onClick={() => { setFocus(i); b.run(); }}>{b.text}</button>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
