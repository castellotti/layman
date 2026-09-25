/**
 * The 34 px strip under the header on all four network tabs (plan §6.1):
 * "GLOVE ·" and the glove session picker, the gate's state as chips, and on the
 * right the tab's Panels chips.
 */
import React from 'react';
import type { NetSessionSummary } from '../../lib/netobs-types.js';
import type { NetSessionData } from '../../lib/net-state.js';
import type { PanelDef } from '../../lib/net-panels.js';
import { gateChips } from '../../lib/net-format.js';
import { Chip, NetIcon, type NetIconName } from './netui.js';

function sessionOption(s: NetSessionSummary): string {
  const parts = [s.token];
  if (s.harness) parts.push(s.harness);
  if (s.live) parts.push('live');
  return `${s.live ? '● ' : ''}${parts.join(' · ')}`;
}

export function GateStrip({ sessions, token, onPick, data, panels, isVisible, onToggle }: {
  sessions: NetSessionSummary[];
  token: string | null;
  onPick: (token: string) => void;
  data: NetSessionData | null;
  panels: readonly PanelDef[];
  isVisible: (id: string) => boolean;
  onToggle: (id: string) => void;
}) {
  const known = token !== null && sessions.some((s) => s.token === token);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px', background: 'var(--bg)',
      borderBottom: '1px solid var(--border)', flexShrink: 0, overflow: 'hidden', fontFamily: 'var(--font-ui)',
    }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-faint)', fontWeight: 600, marginRight: 4, flexShrink: 0 }}>
        GLOVE ·
        {sessions.length > 0 ? (
          <select
            aria-label="Glove session"
            value={known ? token! : ''}
            onChange={(e) => e.target.value && onPick(e.target.value)}
            style={{
              fontSize: 10, letterSpacing: '0.04em', fontWeight: 600, fontFamily: 'var(--font-ui)',
              color: 'var(--text-muted)', background: 'transparent', border: 'none', outline: 'none',
              cursor: 'pointer', padding: 0, maxWidth: 220,
            }}
          >
            {!known && <option value="">{token ?? 'choose a session'}</option>}
            {sessions.map((s) => <option key={s.token} value={s.token}>{sessionOption(s)}</option>)}
          </select>
        ) : (
          <span>{token ?? 'no sessions'}</span>
        )}
      </label>

      {/* The chips give way before the controls do: they shrink and scroll
          sideways (trackpad or shift-wheel) while the Panels chips stay whole.
          The loud chips come first, so they are the last to be clipped. */}
      <div
        className="net-chip-row"
        style={{
          display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 auto', minWidth: 0, overflowX: 'auto', scrollbarWidth: 'none',
          // Fade the last 16 px, so a clipped chip reads as "more to the right", not as a rendering fault.
          maskImage: 'linear-gradient(to right, black calc(100% - 16px), transparent)',
          WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 16px), transparent)',
        }}
      >
        {data && gateChips(data).map((c) => (
          <Chip key={c.key} tone={c.tone} icon={c.icon} label={c.label} title={c.title} strong={c.key === 'direct'} />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <span style={{ fontSize: 10, color: 'var(--text-faint)', marginRight: 2 }}>Panels</span>
        {panels.map((p) => {
          const on = isVisible(p.id);
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              title={`Show or hide the ${p.chip} panel`}
              onClick={() => onToggle(p.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 4, height: 24, padding: '0 7px', fontSize: 10.5,
                borderRadius: 5, border: `1px solid ${on ? 'var(--border-strong)' : 'var(--border)'}`,
                background: on ? 'var(--bg-selected)' : 'transparent', color: on ? 'var(--text)' : 'var(--text-faint)',
                cursor: 'pointer', fontFamily: 'var(--font-ui)',
              }}
            >
              <NetIcon name={p.icon as NetIconName} color={on ? 'var(--text-body)' : 'var(--text-faint)'} />
              {p.chip}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * glove refused the rules file (plan §6.2): pinned under the strip on every
 * network tab while `rules.ok` is false. Read-only until the rules writer
 * exists: "Show file" is here; "Revert to enforced rules" and "Try again" need
 * something to revert and retry with, and arrive with it.
 */
export function RulesRejectedBanner({ data }: { data: NetSessionData }) {
  const [open, setOpen] = React.useState(false);
  const rules = data.gate.rules;
  if (!rules || rules.ok) return null;
  const n = rules.active_count;
  const fileText = data.rules.readError
    ? data.rules.readError
    : data.rules.file ? JSON.stringify(data.rules.file, null, 2) : 'rules.json is not present.';
  return (
    <div style={{ padding: '8px 12px 0', flexShrink: 0 }}>
      <div role="alert" style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 8,
        background: '#2A0F0E', border: '1px solid var(--error)',
      }}>
        <NetIcon name="alert" size={20} color="var(--error)" strokeWidth={1.8} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#FFB4AD' }}>Your last rules change did not take effect</div>
          <div style={{ fontSize: 11.5, color: '#F3C6C1', marginTop: 2 }}>
            glove rejected rules.json: <span style={{ fontFamily: 'var(--font-mono)' }}>{rules.error ?? 'no reason given'}</span>.
            {' '}The gate is still enforcing the previous {n} rule{n === 1 ? '' : 's'}.
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', marginTop: 3 }}>
            status.json · rules.ok false{rules.loaded_at ? ` · last good load ${rules.loaded_at}` : ''}
          </div>
        </div>
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 10px', borderRadius: 6,
          fontSize: 11.5, fontWeight: 500, whiteSpace: 'nowrap', background: 'var(--bg-pill)',
          border: '1px solid var(--border-strong)', color: 'var(--text)', cursor: 'pointer', fontFamily: 'var(--font-ui)',
        }}>
          <NetIcon name="file" />{open ? 'Hide file' : 'Show file'}
        </button>
      </div>
      {open && (
        <pre style={{
          margin: '6px 0 0', maxHeight: 220, overflow: 'auto', padding: 10, fontSize: 11, fontFamily: 'var(--font-mono)',
          color: 'var(--text-body)', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6,
        }}>
          {data.rules.displayPath}{'\n\n'}{fileText}
        </pre>
      )}
    </div>
  );
}
