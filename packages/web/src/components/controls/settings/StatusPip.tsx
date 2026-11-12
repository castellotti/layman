import React from 'react';

export function StatusPip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      style={{
        fontSize: 9.5,
        padding: '2px 6px',
        borderRadius: 999,
        background: ok ? 'color-mix(in srgb, var(--ok) 15%, transparent)' : 'color-mix(in srgb, var(--error) 15%, transparent)',
        color: ok ? 'var(--ok)' : 'var(--error)',
      }}
    >
      {label}
    </span>
  );
}
