import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './index.css';
import { applyTheme, rememberedAppearance } from './lib/theme-runtime.js';
import { DEFAULT_APPEARANCE } from './lib/themes.js';

// What this browser last applied, else Classic (index.css's values), until the config arrives
// and useAppearance applies its appearance block.
applyTheme(rememberedAppearance() ?? DEFAULT_APPEARANCE);

// Request notification permission on load
if ('Notification' in window && Notification.permission === 'default') {
  void Notification.requestPermission();
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

createRoot(rootEl).render(<App />);
