import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './index.css';
import { applyTheme } from './lib/theme-runtime.js';
import { DEFAULT_APPEARANCE } from './lib/themes.js';

// Classic until the config's appearance block is read: the same values as index.css.
applyTheme(DEFAULT_APPEARANCE);

// Request notification permission on load
if ('Notification' in window && Notification.permission === 'default') {
  void Notification.requestPermission();
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

createRoot(rootEl).render(<App />);
