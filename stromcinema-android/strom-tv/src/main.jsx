import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/big-shoulders-display/latin-700';
import '@fontsource/big-shoulders-display/latin-900';
import '@fontsource/instrument-sans/latin-400';
import '@fontsource/instrument-sans/latin-500';
import '@fontsource/instrument-sans/latin-600';
import '@fontsource/instrument-sans/latin-700';
import './tv.css';
import './case3d.css';
import App from './App.jsx';
import { applySavedBackground } from './theme.js';
applySavedBackground(); // no colour flash on start
import { onBackButton, isDesktop } from './native.js';
import { dispatchInput } from './input.js';

onBackButton(() => dispatchInput('back'));
if (isDesktop) document.body.classList.add('desktop');

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
