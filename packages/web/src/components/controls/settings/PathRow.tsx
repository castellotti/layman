import React, { useEffect, useRef, useState } from 'react';
import { CustomRow } from './primitives.js';
import { PathPicker, BTN } from './PathPicker.js';
import { sp, rad } from '../../../lib/density.js';

/**
 * A path setting: the label on its own line, then a full-width field (the whole path, not a 220 px
 * slice of it) and Browse…, then any status or help lines as children. The value is committed on
 * blur or Enter, never per keystroke: a half-typed path would be stored and used.
 */
export function PathRow({ label, value, placeholder, onCommit, mode, ext, ariaLabel, children }: {
  label: string;
  value: string;
  placeholder: string;
  onCommit: (v: string) => void;
  mode: 'dir' | 'file';
  ext?: string;
  ariaLabel?: string;
  children?: React.ReactNode;
}) {
  const [draft, setDraft] = useState(value);
  const [browsing, setBrowsing] = useState(false);
  const browseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setDraft(value), [value]);
  const commit = (v: string) => {
    const t = v.trim();
    if (t !== value) onCommit(t);
  };
  const close = () => { setBrowsing(false); browseRef.current?.focus(); };

  return (
    <CustomRow>
      <span style={{ fontSize: 12, color: 'var(--text)' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: sp(8) }}>
        <input
          type="text"
          value={draft}
          placeholder={placeholder}
          title={value || placeholder}
          aria-label={ariaLabel ?? label}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(draft); }}
          spellCheck={false}
          style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', padding: sp('4px 6px'), fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg-card)', border: 'var(--stroke) solid var(--border-strong)', borderRadius: rad(5), color: 'var(--text)', outline: 'none' }}
        />
        <button
          ref={browseRef}
          type="button"
          onClick={() => setBrowsing(true)}
          style={BTN}
        >
          Browse…
        </button>
      </div>
      {children}
      {browsing && (
        <PathPicker
          title={`Choose: ${label}`}
          mode={mode}
          ext={ext}
          start={draft.trim() || placeholder}
          onChoose={(p) => { setDraft(p); commit(p); close(); }}
          onClose={close}
        />
      )}
    </CustomRow>
  );
}
