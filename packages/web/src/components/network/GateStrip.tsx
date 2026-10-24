/**
 * The 34 px strip under the header on all four network tabs:
 * "GLOVE ·" and the glove session picker, the time range (a calendar icon that shows or
 * hides the range display, and the range, which opens the picker), the gate's state as
 * chips, and on the right the tab's Panels chips.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { NetNotObservable, NetRange, NetRangeInfo, NetSessionSummary } from '../../lib/netobs-types.js';
import { formatRange, rangeGaps, rangeHourly, rangeLead, rangeTitle } from '../../lib/net-range.js';
import { endedRun, rangeName } from '../../lib/net-picker.js';
import { useNow } from '../../hooks/useNow.js';
import { useNetSegments } from '../../hooks/useNetSegments.js';
import type { NetSessionData } from '../../lib/net-state.js';
import type { PanelDef } from '../../lib/net-panels.js';
import { chipCollapses, gateChips } from '../../lib/net-format.js';
import { RangePicker } from './RangePicker.js';
import { REJECTED_TITLE, rejectedAuthor } from '../../lib/net-rules.js';
import { Chip, NetIcon, useStored, type NetIconName } from './netui.js';
import { TipWrap, tipProps } from './NetTip.js';
import { useNetStore } from '../../stores/netStore.js';

const bannerButton: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 10px', borderRadius: 6,
  fontSize: 11.5, fontWeight: 500, whiteSpace: 'nowrap', background: 'var(--bg-pill)',
  border: '1px solid var(--border-strong)', color: 'var(--text)', cursor: 'pointer', fontFamily: 'var(--font-ui)',
};

function sessionOption(s: NetSessionSummary): string {
  const parts = [s.token];
  if (s.harness) parts.push(s.harness);
  if (s.live) parts.push('live');
  if (s.historyOnly) parts.push('history');
  if (s.glove.orphaned) parts.push('deleted · export retained');
  if (s.glove.filter === 'granted') parts.push('filter');
  if (s.glove.filter === 'revoked') parts.push('filter revoked');
  return `${s.live ? '● ' : ''}${parts.join(' · ')}`;
}

const DISPLAY_KEY = 'layman.net.rangeDisplay';
const GAP_KEY = 'layman.net.burstGap';

const rankIn = (order: readonly string[], token: string) => { const i = order.indexOf(token); return i < 0 ? order.length : i; };

/** A range running until now: its length grows, so only this ticks. */
function RangeText({ range }: { range: NetRange }) {
  const now = useNow(range.to === null ? 1000 : 3_600_000);
  return <>{formatRange(range, now)}</>;
}

/**
 * The calendar icon, and with the display on, the range (or "All records") as the button that
 * opens the picker, and ✕ back to All records. With a range set the icon stays lit and its tip
 * gives the range, so hiding the display never hides that the figures are filtered.
 */
function RangeControl({ token, range, onRange, display, setDisplay }: {
  token: string | null; range: NetRange | null; onRange: (r: NetRange | null) => void; display: boolean; setDisplay: (on: boolean) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [gapHours, setGapHours] = useStored(GAP_KEY, 6, (raw) => (Number(raw) >= 1 && Number(raw) <= 24 ? Number(raw) : null));
  // Asked for only when they are used: by the picker, or to name a range and close a run's.
  const { segments, error } = useNetSegments(anchor || range ? token : null, gapHours);
  const name = range ? rangeName(range, segments) : null;
  const ended = range ? endedRun(range, segments) : null;
  useEffect(() => { if (ended) onRange(ended); }, [ended?.from, ended?.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = useCallback(() => setAnchor(null), []);
  const lit = range !== null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <button type="button" data-range-button="" aria-label={display ? 'Hide the time range' : 'Show the time range'} aria-pressed={display}
        onClick={() => { setDisplay(!display); setAnchor(null); }}
        {...tipProps(range
          ? { heading: 'A time range is set', body: 'Every figure on these tabs is for this range only: bytes are what moved during it.', facts: [`${name ? `${name} · ` : ''}${formatRange(range)}`, rangeTitle(range)] }
          : { heading: 'All records', body: display ? 'Hide the time range, to make room for the gate’s state.' : 'Show the time range, to choose a run, a day or a span of this session.' })}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 5, cursor: 'pointer',
          border: `1px solid ${lit ? 'var(--info)' : 'var(--border)'}`,
          background: lit ? 'color-mix(in srgb, var(--info) 22%, transparent)' : 'transparent',
        }}>
        <NetIcon name="calendar" color={lit ? 'var(--info)' : 'var(--text-muted)'} strokeWidth={lit ? 1.8 : 1.4} />
      </button>
      {display && (
        <>
          <button type="button" data-range-button="" aria-haspopup="dialog" aria-expanded={anchor !== null} aria-label="Time range"
            disabled={token === null}
            onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
            {...tipProps(range ? { heading: name ?? 'Time range', body: 'Only the traffic in this range: bytes are what moved during it. Click to choose another.', facts: [rangeTitle(range)] } : 'Choose a run, a day or a span of this session')}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, height: 24, padding: '0 8px', borderRadius: 5, cursor: 'pointer',
              fontSize: 10.5, fontFamily: range ? 'var(--font-mono)' : 'var(--font-ui)', whiteSpace: 'nowrap',
              color: range ? 'var(--text)' : 'var(--text-muted)', background: anchor ? 'var(--bg-selected)' : 'transparent',
              border: `1px solid ${range ? 'color-mix(in srgb, var(--info) 55%, transparent)' : 'var(--border)'}`,
            }}>
            {range ? <>{name && <span style={{ fontFamily: 'var(--font-ui)', fontWeight: 600 }}>{name} ·</span>}<RangeText range={range} /></> : 'All records'}
            <NetIcon name="chevron" size={10} color="var(--text-faint)" />
          </button>
          {range && (
            <button type="button" aria-label="Show All records" onClick={() => onRange(null)} {...tipProps('Back to All records')} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, cursor: 'pointer',
              background: 'transparent', border: 'none',
            }}>
              <NetIcon name="close" size={10} color="var(--text-muted)" />
            </button>
          )}
        </>
      )}
      {anchor && (
        <RangePicker anchor={anchor} range={range} segments={segments} segmentsError={error} gapHours={gapHours} setGapHours={setGapHours}
          onPick={onRange} onClose={close} />
      )}
    </div>
  );
}

export function GateStrip({ sessions, notObservable, token, onPick, range, onRange, data, panels, isVisible, onToggle }: {
  sessions: NetSessionSummary[];
  notObservable: NetNotObservable[];
  token: string | null;
  onPick: (token: string) => void;
  /** The range asked for (`netRange`), shown while it loads too. */
  range: NetRange | null;
  onRange: (range: NetRange | null) => void;
  data: NetSessionData | null;
  panels: readonly PanelDef[];
  isVisible: (id: string) => boolean;
  onToggle: (id: string) => void;
}) {
  const known = token !== null && (sessions.some((s) => s.token === token) || notObservable.some((s) => s.token === token));
  // While the list is open its order is frozen: the Dashboard's order follows agent activity, and
  // a row moving under the pointer picks the wrong session. New sessions join at the end.
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const listed = frozen === null ? sessions : [...sessions].sort((a, b) => rankIn(frozen, a.token) - rankIn(frozen, b.token));
  const [display, setDisplay] = useStored<'on' | 'off'>(DISPLAY_KEY, 'on', (raw) => (raw === 'off' || raw === 'on' ? raw : null));
  const shown = display === 'on';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px', background: 'var(--bg)',
      borderBottom: '1px solid var(--border)', flexShrink: 0, overflow: 'hidden', fontFamily: 'var(--font-ui)',
    }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-faint)', fontWeight: 600, marginRight: 4, flexShrink: 0 }}>
        GLOVE ·
        {sessions.length + notObservable.length > 0 ? (
          <select
            aria-label="Glove session"
            value={known ? token! : ''}
            onChange={(e) => { setFrozen(null); if (e.target.value) onPick(e.target.value); }}
            onFocus={() => setFrozen(sessions.map((s) => s.token))} onBlur={() => setFrozen(null)}
            style={{
              fontSize: 10, letterSpacing: '0.04em', fontWeight: 600, fontFamily: 'var(--font-ui)',
              color: 'var(--text-muted)', background: 'transparent', border: 'none', outline: 'none',
              cursor: 'pointer', padding: 0, maxWidth: 220,
            }}
          >
            {!known && <option value="">{token ?? 'choose a session'}</option>}
            {/* A session without the observe grant is listed greyed out: Layman may not read it. */}
            {listed.map((s) => <option key={s.token} value={s.token}>{sessionOption(s)}</option>)}
            {notObservable.map((s) => <option key={s.token} value={s.token} disabled>{[s.token, s.harness, 'not observable'].filter(Boolean).join(' · ')}</option>)}
          </select>
        ) : (
          <span>{token ?? 'no sessions'}</span>
        )}
      </label>

      <RangeControl token={known ? token : null} range={range} onRange={onRange} display={shown} setDisplay={(on) => setDisplay(on ? 'on' : 'off')} />

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
          c.key === 'cut' ? (
            <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <Chip tone={c.tone} icon={c.icon} label={c.label} tip={c.tip} strong />
              <button type="button" disabled={data.rules.control.state !== 'ok'} onClick={() => useNetStore.getState().applyRules({ kind: 'restoreAll' })}
                style={{ height: 20, padding: '0 8px', borderRadius: 10, fontSize: 10.5, cursor: 'pointer', fontFamily: 'var(--font-ui)', color: 'var(--net-tunnel)', background: 'rgba(53,201,180,0.12)', border: '1px solid rgba(53,201,180,0.45)' }}>
                Restore
              </button>
            </span>
          ) : <Chip key={c.key} tone={c.tone} icon={c.icon} label={c.label} tip={c.tip} strong={c.key === 'direct'} compact={shown && chipCollapses(c)} />
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
              data-tip={`Show or hide the ${p.chip} panel`}
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
 * What a time range could not cover, pinned under the strip on every network tab: what glove
 * deleted or a scan skipped (`rangeGaps`), the part from Layman's hourly history, and a start
 * before the session's. Nothing when the range is whole: the span itself is in the strip.
 */
export function RangeBanner({ range }: { range: NetRangeInfo }) {
  const gaps = rangeGaps(range);
  const notes = [rangeLead(range), rangeHourly(range)].filter(Boolean).join(' ');
  if (!gaps.length && !notes) return null;
  return (
    <div role="status" aria-label="Range coverage" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', flexShrink: 0, fontFamily: 'var(--font-ui)',
      fontSize: 11.5, borderBottom: '1px solid var(--border)',
      background: 'color-mix(in srgb, var(--info) 8%, transparent)', color: 'var(--text-body)',
    }}>
      <NetIcon name="calendar" color="var(--info)" />
      {notes && <span style={{ color: 'var(--text-faint)' }}>{notes}</span>}
      {gaps.length > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--warn)' }}>
          <NetIcon name="alert" color="var(--warn)" />{gaps.join(' ')}
        </span>
      )}
    </div>
  );
}

/**
 * glove refused the rules file: pinned under the strip on every
 * network tab while `rules.ok` is false. "Revert to enforced rules" writes back
 * the bytes the gate is enforcing (Layman remembers every valid version it has
 * read, by hash); "Try again" writes the current file again through the
 * ownership contract, which is what fixes an unreadable file.
 */
export function RulesRejectedBanner({ data }: { data: NetSessionData }) {
  const [open, setOpen] = React.useState(false);
  const rules = data.gate.rules;
  if (!rules || rules.ok) return null;
  const n = rules.active_count;
  // glove's follow-up: an unreadable file is a rejection too, reported as "cannot read rules.json: …".
  const unreadable = rules.error?.startsWith('cannot read') ?? false;
  const control = data.rules.control.state === 'ok' ? null : data.rules.control.detail;
  const canRevert = !control && (data.rules.enforced !== null || (rules.sha256 === null && rules.source_mtime === null));
  const canRetry = !control && data.rules.exists && !data.rules.invalid && !data.rules.readError;
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
          <div style={{ fontSize: 13, fontWeight: 700, color: '#FFB4AD' }}>
            {unreadable ? 'The gate cannot read your rules file' : REJECTED_TITLE[rejectedAuthor(data.rules)]}
          </div>
          <div style={{ fontSize: 11.5, color: '#F3C6C1', marginTop: 2 }}>
            {unreadable
              ? <>glove reports <span style={{ fontFamily: 'var(--font-mono)' }}>{rules.error}</span>. That is almost always ownership: the gate runs as your user, and rules.json must be readable by it.</>
              : <>glove rejected rules.json: <span style={{ fontFamily: 'var(--font-mono)' }}>{rules.error ?? 'no reason given'}</span>.</>}
            {' '}The gate is still enforcing the previous {n} rule{n === 1 ? '' : 's'}.
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', marginTop: 3 }}>
            status.json · rules.ok false{rules.loaded_at ? ` · last good load ${rules.loaded_at}` : ''}
          </div>
        </div>
        <TipWrap tip={canRevert ? 'Write back the rules the gate is enforcing' : 'Layman has not seen the file the gate is enforcing'} disabled={!canRevert}>
          <button type="button" disabled={!canRevert}
            onClick={() => useNetStore.getState().applyRules({ kind: 'revert' })} style={bannerButton}>
            <NetIcon name="direct" />Revert to enforced rules
          </button>
        </TipWrap>
        <TipWrap tip={canRetry ? 'Write rules.json again, handed to the gate’s user' : control ?? 'The file on disk is invalid'} disabled={!canRetry}>
          <button type="button" disabled={!canRetry}
            onClick={() => useNetStore.getState().applyRules({ kind: 'rewrite' })} style={{ ...bannerButton, color: '#FF8A80', border: '1px solid rgba(240,86,74,0.6)', background: 'transparent' }}>
            Try again
          </button>
        </TipWrap>
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
