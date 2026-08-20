import React, { useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';

/**
 * Shown when a deep link names something this instance does not have.
 *
 * A blank screen or a raw 404 is the failure mode to avoid: links travel between
 * machines (an Obsidian note, a chat message, a federated hub), so the panel has
 * to name *which* instance came up empty and offer a way onward from here.
 */
export function RouteErrorPanel() {
  const routeError = useSessionStore((s) => s.routeError);
  const clearRouteError = useSessionStore((s) => s.clearRouteError);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const setSessionsSearchSeed = useSessionStore((s) => s.setSessionsSearchSeed);
  const [query, setQuery] = useState('');

  if (!routeError) return null;

  const search = () => {
    setSessionsSearchSeed(query.trim());
    setViewMode('sessions');
    clearRouteError();
  };

  const goDashboard = () => {
    setViewMode('dashboard');
    clearRouteError();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(4,6,10,0.72)', fontFamily: 'var(--font-ui)',
    }}>
      <div style={{
        width: 460, maxWidth: '92vw',
        background: 'var(--bg-raised)', border: '1px solid var(--border-strong)',
        borderRadius: 8, padding: '18px 20px',
        display: 'flex', flexDirection: 'column', gap: 12,
        boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Not found on this instance</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={goDashboard}
            style={{ background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: 16, cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>

        <p style={{ margin: 0, fontSize: 11.5, color: 'var(--text-body)', lineHeight: 1.55 }}>
          {routeError.message}
        </p>

        <p style={{ margin: 0, fontSize: 10.5, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
          {routeError.instanceUrl}
        </p>

        <p style={{ margin: 0, fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          The link may point at a different Layman, or the session may have been purged from this one.
        </p>

        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
            placeholder="Search sessions and content…"
            style={{
              flex: 1, padding: '5px 10px', fontSize: 11, fontFamily: 'var(--font-mono)',
              background: 'var(--bg-card)', border: '1px solid var(--border-strong)',
              borderRadius: 5, color: 'var(--text)', outline: 'none', boxSizing: 'border-box',
            }}
          />
          <button
            onClick={search}
            style={{
              padding: '5px 12px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
              background: 'var(--bg-selected)', border: '1px solid var(--border-strong)',
              color: 'var(--text)', fontFamily: 'inherit',
            }}
          >
            Search
          </button>
        </div>

        <button
          onClick={goDashboard}
          style={{
            alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0,
            fontSize: 10.5, color: 'var(--text-faint)', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          Go to dashboard
        </button>
      </div>
    </div>
  );
}
