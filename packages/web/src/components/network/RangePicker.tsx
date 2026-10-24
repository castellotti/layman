/**
 * The range picker, opened from the strip's calendar button: ready-made ranges (Runs, Bursts,
 * Agent sessions), a Calendar (days shaded by activity, start and end fields, presets) and a
 * Timeline (the session's hours with a brush that snaps to run and agent-session edges). It
 * only sets `netRange`; the server builds the range (`netobs/range.ts`). Arithmetic is in
 * `lib/net-picker.ts`.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NetRange, NetSegments } from '../../lib/netobs-types.js';
import { formatBytes } from '../../lib/net-format.js';
import { formatRange, formatSpan, formatStamp, rangeTitle } from '../../lib/net-range.js';
import {
  brushRange, burstRun, dayStart, fromLocalInput, initialMonth, monthGrid, newestFirst, nextDay, presets, runEnd, sameRange,
  segmentRange, snap, timeAt, timelineMarks, timelineSpan, toLocalInput, xAt,
} from '../../lib/net-picker.js';
import { useNow } from '../../hooks/useNow.js';
import { buttonStyle } from './ControlPopover.js';
import { NetIcon } from './netui.js';
import { tipProps } from './NetTip.js';

const WIDTH = 520;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
type Tab = 'segments' | 'calendar' | 'timeline';
type Kind = 'runs' | 'bursts' | 'agents';

const tabStyle = (on: boolean): React.CSSProperties => ({
  height: 26, padding: '0 10px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', fontFamily: 'var(--font-ui)',
  border: `1px solid ${on ? 'var(--border-strong)' : 'transparent'}`, background: on ? 'var(--bg-selected)' : 'transparent',
  color: on ? 'var(--text)' : 'var(--text-muted)',
});

const traffic = (s: { flows: number; bytesUp: number; bytesDown: number }) =>
  `${s.flows.toLocaleString()} flow${s.flows === 1 ? '' : 's'} · ${formatBytes(s.bytesUp + s.bytesDown)}`;

/** One ready-made range: a click sets it. */
function SegmentRow({ title, range, detail, set, onPick, now }: {
  title: string; range: NetRange; detail: string; set: NetRange | null; onPick: (r: NetRange) => void; now: number;
}) {
  const on = sameRange(range, set);
  return (
    <button type="button" aria-pressed={on} onClick={() => onPick(range)} {...tipProps(rangeTitle(range))} style={{
      display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 2, width: '100%', textAlign: 'left', padding: '6px 9px',
      borderRadius: 6, cursor: 'pointer', fontFamily: 'var(--font-ui)', background: on ? 'rgba(90,156,248,0.10)' : 'transparent',
      border: `1px solid ${on ? 'var(--info)' : 'transparent'}`, color: 'var(--text)',
    }}>
      <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11.5 }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-body)' }}>{formatRange(range, now)}</span>
      </span>
      <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{detail}</span>
    </button>
  );
}

function SegmentsTab({ segments, range, onPick, gapHours, setGapHours, now }: {
  segments: NetSegments; range: NetRange | null; onPick: (r: NetRange) => void; gapHours: number; setGapHours: (h: number) => void; now: number;
}) {
  const [kind, setKind] = useState<Kind>('runs');
  const runs = newestFirst(segments.runs);
  const bursts = newestFirst(segments.bursts);
  const agents = newestFirst(segments.agentSessions);
  const empty = (what: string) => <div style={{ padding: 12, fontSize: 11.5, color: 'var(--text-muted)' }}>{what}</div>;
  return (
    <>
      <div role="group" aria-label="Kind" style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
        {([['runs', `Runs ${runs.length}`], ['bursts', `Bursts ${bursts.length}`], ['agents', `Agent sessions ${agents.length}`]] as const).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} style={tabStyle(kind === k)}>{label}</button>
        ))}
        {kind === 'bursts' && (
          <label {...tipProps({ heading: 'Burst gap', body: 'A burst is the agent at work: model calls with no pause this long or longer, inside one run. A gate left up for days holds several jobs, which a run alone lumps together.' })}
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--text-muted)' }}>
            split at
            <select aria-label="Burst gap" value={gapHours} onChange={(e) => setGapHours(Number(e.target.value))} style={{
              fontSize: 10.5, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 4,
            }}>
              {[1, 2, 3, 4, 6, 8, 12, 24].map((h) => <option key={h} value={h}>{h} h</option>)}
            </select>
            gaps
          </label>
        )}
      </div>
      <div role="list" aria-label={kind} style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {kind === 'runs' && (runs.length ? runs.map((r) => (
          <div role="listitem" key={r.run}>
            <SegmentRow title={`Run ${segments.runs.indexOf(r) + 1}`} range={segmentRange(r)} set={range} onPick={onPick} now={now}
              detail={[runEnd(r) ?? 'running', traffic(r)].join(' · ')} />
          </div>
        )) : empty('No runs recorded: glove writes one at each glove up.'))}
        {kind === 'bursts' && (bursts.length ? bursts.map((b) => {
          const n = burstRun(segments, b);
          return (
            <div role="listitem" key={`${b.from}`}>
              <SegmentRow title={n === null ? 'Burst' : `Burst · run ${n}`} range={segmentRange(b)} set={range} onPick={onPick} now={now}
                detail={traffic(b)} />
            </div>
          );
        }) : empty('No bursts of activity.'))}
        {kind === 'agents' && (agents.length ? agents.map((a) => (
          <div role="listitem" key={a.sessionId}>
            <SegmentRow title={`${a.turns} turn${a.turns === 1 ? '' : 's'}`} range={segmentRange(a)} set={range} onPick={onPick} now={now}
              detail={`Layman session ${a.sessionId.slice(0, 8)}${a.exact ? '' : ' · times as read, may lag'}`} />
          </div>
        )) : empty('No Layman session is named after this glove session.'))}
      </div>
      {kind === 'bursts' && segments.burstBasis === 'traffic' && (
        <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 6 }}>No model calls were seen, so bursts are split on all traffic.</div>
      )}
    </>
  );
}

function CalendarTab({ segments, range, onPick, now }: { segments: NetSegments | null; range: NetRange | null; onPick: (r: NetRange) => void; now: number }) {
  const hours = segments?.hours ?? [];
  const [month, setMonth] = useState(() => initialMonth(range, hours, now));
  const [from, setFrom] = useState(range ? toLocalInput(range.from) : '');
  const [to, setTo] = useState(range?.to != null ? toLocalInput(range.to) : '');
  const weeks = useMemo(() => monthGrid(month.year, month.month, hours), [month, hours]);
  const step = (d: number) => setMonth((m) => {
    const x = new Date(m.year, m.month + d, 1);
    return { year: x.getFullYear(), month: x.getMonth() };
  });
  const today = dayStart(now);
  // A day is that day; shift-click runs from the set range's start through the day clicked.
  const pickDay = (day: number, extend: boolean) => {
    const start = extend && range ? Math.min(range.from, day) : day;
    const end = nextDay(Math.max(day, extend && range ? dayStart(range.from) : day));
    const r = { from: start, to: end > now ? null : end };
    setFrom(toLocalInput(r.from));
    setTo(r.to === null ? '' : toLocalInput(r.to));
    onPick(r);
  };
  const f = fromLocalInput(from);
  const t = to.trim() === '' ? null : fromLocalInput(to);
  const valid = f !== null && (to.trim() === '' || (t !== null && t > f));
  const field: React.CSSProperties = {
    fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border-strong)',
    borderRadius: 4, padding: '3px 5px', colorScheme: 'dark',
  };
  return (
    <>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
        {presets(now, segments).map((p) => (
          <button key={p.key} type="button" aria-pressed={sameRange(p.range, range)} onClick={() => onPick(p.range)} style={tabStyle(sameRange(p.range, range))}>{p.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <button type="button" aria-label="Previous month" onClick={() => step(-1)} style={buttonStyle('ghost')}><span style={{ transform: 'rotate(90deg)', display: 'inline-block' }}><NetIcon name="chevron" /></span></button>
        <span style={{ flex: 1, textAlign: 'center', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{MONTHS[month.month]} {month.year}</span>
        <button type="button" aria-label="Next month" onClick={() => step(1)} style={buttonStyle('ghost')}><span style={{ transform: 'rotate(-90deg)', display: 'inline-block' }}><NetIcon name="chevron" /></span></button>
      </div>
      <div role="grid" aria-label={`${MONTHS[month.month]} ${month.year}`} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3 }}>
        {WEEKDAYS.map((d) => <div key={d} role="columnheader" style={{ fontSize: 10, textAlign: 'center', color: 'var(--text-faint)' }}>{d}</div>)}
        {weeks.flat().map((c) => {
          const inRange = range !== null && c.day < (range.to ?? now) && nextDay(c.day) > range.from;
          const future = c.day > today;
          return (
            <button key={c.day} type="button" role="gridcell" disabled={future} data-day={toLocalInput(c.day).slice(0, 10)} aria-selected={inRange}
              onClick={(e) => pickDay(c.day, e.shiftKey)}
              {...tipProps(c.flows ? `${traffic({ flows: c.flows, bytesUp: c.bytes, bytesDown: 0 })}. Shift-click to extend the range to this day.` : 'No traffic recorded')}
              style={{
                height: 30, borderRadius: 5, fontSize: 11, fontFamily: 'var(--font-mono)', cursor: future ? 'default' : 'pointer',
                color: c.inMonth ? (future ? 'var(--text-faint)' : 'var(--text)') : 'var(--text-faint)',
                background: c.level ? `color-mix(in srgb, var(--net-tunnel) ${8 + c.level * 14}%, transparent)` : 'transparent',
                border: `1px solid ${inRange ? 'var(--info)' : c.day === today ? 'var(--border-strong)' : 'var(--border)'}`,
                opacity: c.inMonth ? 1 : 0.55,
              }}>
              {c.date}
            </button>
          );
        })}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (valid) onPick({ from: f!, to: t }); }}
        style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--text-muted)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>From
          <input type="datetime-local" step={1} aria-label="Range start" value={from} onChange={(e) => setFrom(e.target.value)} style={field} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>to
          <input type="datetime-local" step={1} aria-label="Range end" value={to} onChange={(e) => setTo(e.target.value)} placeholder="now" style={field} />
        </label>
        <span style={{ color: 'var(--text-faint)' }}>{to.trim() === '' ? '(empty: now)' : ''}</span>
        <button type="submit" disabled={!valid} style={{ ...buttonStyle('plain'), marginLeft: 'auto', opacity: valid ? 1 : 0.5 }}>Apply</button>
      </form>
    </>
  );
}

const TL_W = WIDTH - 24;
const TL_H = 86;
const SNAP_PX = 8;

function TimelineTab({ segments, range, onPick, now }: { segments: NetSegments; range: NetRange | null; onPick: (r: NetRange) => void; now: number }) {
  const span = useMemo(() => timelineSpan(segments, now), [segments, now]);
  const marks = useMemo(() => timelineMarks(segments), [segments]);
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (!span) return <div style={{ padding: 12, fontSize: 11.5, color: 'var(--text-muted)' }}>No activity recorded yet.</div>;
  const live = segments.runs.some((r) => r.to === null);
  const tol = (SNAP_PX / TL_W) * (span.to - span.from);
  const at = (e: React.PointerEvent) => snap(timeAt(e.clientX - svg.current!.getBoundingClientRect().left, TL_W, span), marks, tol);
  const x = (t: number) => xAt(t, TL_W, span);
  const max = Math.max(1, ...segments.hours.map((h) => h.flows));
  const shown = drag ? { from: Math.min(drag.a, drag.b), to: Math.max(drag.a, drag.b) } : range ? { from: range.from, to: range.to ?? now } : null;
  return (
    <>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 6 }}>
        Drag across the timeline to set a range. Edges snap to runs (ticks) and agent sessions (dots).
      </div>
      <svg ref={svg} width={TL_W} height={TL_H} role="slider" aria-label="Timeline"
        aria-valuetext={shown ? formatRange({ from: shown.from, to: shown.to }, now) : 'All records'}
        style={{ display: 'block', cursor: 'crosshair', touchAction: 'none', background: 'var(--bg)', borderRadius: 5, border: '1px solid var(--border)' }}
        onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); const t = at(e); setDrag({ a: t, b: t }); }}
        onPointerMove={(e) => { const t = at(e); setHover(t); if (drag) setDrag({ ...drag, b: t }); }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={() => {
          if (!drag) return;
          const r = brushRange(drag.a, drag.b, span, live);
          setDrag(null);
          if (r) onPick(r);
        }}>
        {segments.hours.map((h) => {
          const bh = Math.max(1, (Math.log1p(h.flows) / Math.log1p(max)) * (TL_H - 24));
          // From the hour's first record to its last: a whole hour would swamp a session minutes long.
          return <rect key={h.hour} x={x(h.first)} y={TL_H - 12 - bh} width={Math.max(2, x(h.last) - x(h.first))} height={bh}
            fill={h.inference ? 'var(--net-tunnel)' : 'var(--text-faint)'} opacity={0.75} />;
        })}
        {segments.runs.map((r) => (
          <g key={r.run}>
            <line x1={x(r.from)} x2={x(r.from)} y1={0} y2={TL_H - 12} stroke="var(--info)" strokeWidth={1} />
            {r.to !== null && <line x1={x(r.to)} x2={x(r.to)} y1={0} y2={TL_H - 12} stroke="var(--info)" strokeWidth={1} strokeDasharray="2 2" />}
          </g>
        ))}
        {segments.agentSessions.map((a) => (
          <g key={a.sessionId} fill="var(--net-up)">
            <circle cx={x(a.from)} cy={6} r={2.5} />
            <circle cx={x(a.to)} cy={6} r={2.5} />
          </g>
        ))}
        {shown && <rect data-brush="" x={x(shown.from)} y={0} width={Math.max(1, x(shown.to) - x(shown.from))} height={TL_H - 12}
          fill="rgba(90,156,248,0.18)" stroke="var(--info)" />}
        <line x1={0} x2={TL_W} y1={TL_H - 12} y2={TL_H - 12} stroke="var(--border-strong)" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={TL_H - 12} stroke="var(--text-muted)" strokeDasharray="1 2" />}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', marginTop: 3 }}>
        <span>{formatStamp(span.from)}</span>
        <span>{hover !== null ? formatStamp(hover) : formatSpan(span.to - span.from)}</span>
        <span>{live ? 'now' : formatStamp(span.to)}</span>
      </div>
    </>
  );
}

export function RangePicker({ anchor, range, segments, segmentsError, gapHours, setGapHours, onPick, onClose }: {
  anchor: DOMRect;
  range: NetRange | null;
  segments: NetSegments | null;
  segmentsError: string | null;
  gapHours: number;
  setGapHours: (h: number) => void;
  onPick: (r: NetRange | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(1000);
  const [tab, setTab] = useState<Tab>('segments');
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 6 });
  useLayoutEffect(() => {
    setPos({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8)), top: anchor.bottom + 6 });
  }, [anchor]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Not on the button that opened it: that click toggles it closed itself.
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('[data-range-button]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [onClose]);
  // Picking keeps the picker open: the reader often compares a few ranges in a row.
  const pick = (r: NetRange | null) => onPick(r);
  return createPortal(
    <div ref={ref} role="dialog" aria-label="Time range" data-print-hide="" style={{
      position: 'fixed', left: pos.left, top: pos.top, width: WIDTH, zIndex: 60, padding: 12, borderRadius: 8,
      background: 'var(--bg-card)', border: '1px solid var(--border-strong)', boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
      fontFamily: 'var(--font-ui)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10 }}>
        <div role="tablist" aria-label="Pick by" style={{ display: 'flex', gap: 4 }}>
          {([['segments', 'Runs & sessions'], ['calendar', 'Calendar'], ['timeline', 'Timeline']] as const).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={tabStyle(tab === k)}>{label}</button>
          ))}
        </div>
        <button type="button" aria-pressed={range === null} onClick={() => pick(null)} style={{ ...tabStyle(range === null), marginLeft: 'auto' }}>All records</button>
        <button type="button" aria-label="Close" onClick={onClose} style={{ ...buttonStyle('ghost'), width: 26, padding: 0 }}><NetIcon name="close" size={11} /></button>
      </div>
      {segmentsError && !segments && <div role="alert" style={{ fontSize: 11.5, color: 'var(--warn)', marginBottom: 8 }}>Could not read this session’s runs: {segmentsError}</div>}
      {tab === 'calendar' ? <CalendarTab segments={segments} range={range} onPick={pick} now={now} />
        : !segments ? <div style={{ padding: 12, fontSize: 11.5, color: 'var(--text-muted)' }}>{segmentsError ? '' : 'Loading…'}</div>
          : tab === 'segments' ? <SegmentsTab segments={segments} range={range} onPick={pick} gapHours={gapHours} setGapHours={setGapHours} now={now} />
            : <TimelineTab segments={segments} range={range} onPick={pick} now={now} />}
    </div>,
    document.body,
  );
}
