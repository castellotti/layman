import React from 'react';

export function StatusPip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      style={{
        fontSize: 9.5,
        padding: '2px 6px',
        borderRadius: 999,
        background: ok ? 'rgba(76,195,138,0.15)' : 'rgba(240,86,74,0.15)',
        color: ok ? 'var(--ok)' : 'var(--error)',
      }}
    >
      {label}
    </span>
  );
}
