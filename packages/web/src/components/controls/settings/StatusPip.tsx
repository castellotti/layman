import React from 'react';
import { tokenColor } from '../../../lib/tokens.js';
import { sp } from '../../../lib/density.js';

export function StatusPip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      style={{
        fontSize: 9.5,
        padding: sp('2px 6px'),
        borderRadius: 999,
        background: ok ? tokenColor('ok', '15%') : tokenColor('error', '15%'),
        color: ok ? 'var(--ok)' : 'var(--error)',
      }}
    >
      {label}
    </span>
  );
}
