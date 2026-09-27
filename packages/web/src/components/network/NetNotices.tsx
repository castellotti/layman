/**
 * Toasts for the network views: a rules change that could not be
 * written, and rules.json changed by someone other than Layman (glove's CLI, an
 * editor). Layman never treats its own last write as the truth, so an outside
 * change is reported, not overwritten.
 */
import React, { useState } from 'react';
import { useNow } from '../../hooks/useNow.js';
import { useNetStore } from '../../stores/netStore.js';
import type { NetSessionData } from '../../lib/net-state.js';
import { NetIcon } from './netui.js';

/** How long a notice stays up. */
const SHOW_MS = 12_000;

function Toast({ tone, title, children, onDismiss }: { tone: 'error' | 'info'; title: string; children?: React.ReactNode; onDismiss: () => void }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, width: 360, padding: '10px 12px', borderRadius: 8,
      background: 'var(--bg-card)', border: `1px solid ${tone === 'error' ? 'rgba(240,86,74,0.6)' : 'var(--border-strong)'}`,
      boxShadow: '0 12px 32px rgba(0,0,0,0.5)', fontFamily: 'var(--font-ui)',
    }}>
      <NetIcon name={tone === 'error' ? 'alert' : 'file'} color={tone === 'error' ? 'var(--error)' : 'var(--info)'} size={14} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: tone === 'error' ? '#FFB4AD' : 'var(--text)' }}>{title}</div>
        {children && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>{children}</div>}
      </div>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2 }}>
        <NetIcon name="close" size={11} color="var(--text-faint)" />
      </button>
    </div>
  );
}

export function NetNotices({ data }: { data: NetSessionData | null }) {
  const now = useNow(1000);
  const ops = useNetStore((s) => s.ops);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState(false);
  const dismiss = (key: string) => setDismissed((d) => new Set(d).add(key));

  const failed = Object.entries(ops).filter(([id, op]) => op.ok === false && now - op.at < SHOW_MS && !dismissed.has(id));
  const ext = data?.rules.externalChange;
  const extKey = ext ? `ext:${ext.at}` : '';
  const showExt = ext && now - ext.at < SHOW_MS && !dismissed.has(extKey);
  if (!failed.length && !showExt) return null;
  return (
    <div style={{ position: 'fixed', right: 16, bottom: 36, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 65 }}>
      {failed.map(([id, op]) => (
        <Toast key={id} tone="error" title="Could not change the rules" onDismiss={() => dismiss(id)}>{op.error}</Toast>
      ))}
      {showExt && data && (
        <Toast tone="info" title="rules.json changed outside Layman" onDismiss={() => dismiss(extKey)}>
          {data.rules.file ? `Reloaded; ${data.rules.file.rules.length} rule${data.rules.file.rules.length === 1 ? '' : 's'} in the file.` : 'The file was removed: everything is allowed.'}{' '}
          <button type="button" onClick={() => setViewing((v) => !v)} style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--info)', cursor: 'pointer', fontSize: 11 }}>
            {viewing ? 'Hide' : 'View'}
          </button>
          {viewing && (
            <pre style={{ margin: '6px 0 0', maxHeight: 160, overflow: 'auto', fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--text-body)' }}>
              {data.rules.file ? JSON.stringify(data.rules.file, null, 2) : '(no file)'}
            </pre>
          )}
        </Toast>
      )}
    </div>
  );
}
