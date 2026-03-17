import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './index.css';

// Request notification permission on load
if ('Notification' in window && Notification.permission === 'default') {
  void Notification.requestPermission();
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

createRoot(rootEl).render(<App />);
