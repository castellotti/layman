import React, { useMemo, useState } from 'react';
import { useNow } from '../../hooks/useNow.js';
import type { Board } from '../../lib/activity-board.js';
import { routeOf } from '../../lib/activity-board.js';
import { aside, edge, layoutMap, legPath, spoke, spokeWidth, type MapLayout, type Point } from '../../lib/activity-map.js';
import { GLOW_MS, legOpacity, PULSE_MS, pulsesOf, type Pulse, type StationSpec } from '../../lib/activity-view.js';
import { glovePulses, type GloveMap } from '../../lib/activity-glove.js';
import { contextPctColor } from '../../lib/session-state.js';
import { STATION_STYLE } from '../../lib/station-style.js';
import { StationGlyph } from './StationGlyph.js';
import './activity.css';

const FONT = { fontFamily: 'var(--font-ui)', fontSize: 10.5 } as const;

/** The ends of a pulse's path: the core's rim (or the Agents station's) and the station's rim. */
function pulseEnds(layout: MapLayout, p: Pulse): [Point, Point] | undefined {
  if (p.from === 'agents') {
    const agents = layout.stations[layout.index.get('agents') ?? -1];
    const target = layout.stations[layout.index.get(p.station) ?? -1];
    if (!agents || !target || agents === target) return undefined;
    return [edge(agents, target, layout.node), edge(target, agents, layout.node)];
  }
  const s = spoke(layout, p.station);
  return s && [s.from, s.to];
}

/**
 * One pulse. Its delay and lane are taken once, when it appears, so a redraw never restarts its
 * flight or moves it sideways when another pulse joins its spoke.
 */
function PulseDot({ layout, pulse, tint }: { layout: MapLayout; pulse: Pulse; tint: string }) {
  const [delay] = useState(() => -pulse.age / 1000);
  const [lane] = useState(pulse.lane);
  const ends = pulseEnds(layout, pulse);
  if (!ends) return null;
  const [a, b] = aside(ends[0], ends[1], lane);
  const [from, to] = pulse.kind === 'in' ? [b, a] : [a, b];
  const color = pulse.bad ? 'var(--error)' : tint;
  const style = { '--dx': `${to.x - from.x}px`, '--dy': `${to.y - from.y}px`, '--delay': `${delay}s` } as React.CSSProperties;
  return (
    <circle
      className={pulse.kind === 'run' ? 'activity-pulse-run' : 'activity-pulse'}
      cx={from.x}
      cy={from.y}
      r={pulse.kind === 'in' && !pulse.hollow ? 2.6 : 3.6}
      fill={pulse.hollow ? 'none' : color}
      stroke={pulse.hollow ? color : 'none'}
      strokeWidth={1.4}
      style={style}
    />
  );
}

export interface ActivityMapProps {
  board: Board;
  /** What each station shows (`stationSpecs`): Layman's own, or a gloved session's gates in Network's place. */
  stations: readonly StationSpec[];
  width: number;
  height: number;
  /** The session is still going: pulses fly and old legs fade. A finished one shows its whole route still. */
  live: boolean;
  /** What the map is of, for a screen reader. */
  title: string;
  /** A gloved session's gates, joins and loose flows: the pulses glove's records add. */
  glove?: GloveMap | null;
  /** The ring around the whole map: where the sandbox's traffic leaves (`exitRing`), or none. */
  ring?: { color: string; dashed: boolean; title: string } | null;
}

/**
 * The map: stations on a ring around the agent, spokes worn by use, the route, pulses in flight.
 * Memoized: a click or toggle in the feed beside it changes none of its props; its own clock drives it.
 */
export const ActivityMap = React.memo(function ActivityMap({ board, stations, width, height, live, title, glove, ring }: ActivityMapProps) {
  // Its own clock, so only the map redraws twice a second, not the feed beside it.
  const now = useNow(live ? 500 : 60_000);
  // Keyed by the ids themselves: the specs are rebuilt at every event, the ring only when a station comes or goes.
  const idKey = stations.map((s) => s.id).join('\n');
  const layout = useMemo(() => layoutMap(idKey.split('\n'), { width, height }), [idKey, width, height]);
  const route = useMemo(() => routeOf(board.entries), [board]);
  const pulses = live ? pulsesOf(board, now, glove ? glovePulses(glove, board, now, PULSE_MS) : undefined) : [];
  const tint = useMemo(() => new Map(stations.map((s) => [s.id, s.color])), [stations]);
  const agentsAt = layout.stations[layout.index.get('agents') ?? -1];

  return (
    <svg className="activity-map"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={title}
    >
      {/* The exit ring: the whole map is inside the sandbox, and this is where its traffic leaves. */}
      {ring && (
        <rect x={1} y={1} width={Math.max(0, layout.width - 2)} height={Math.max(0, layout.height - 2)} rx={10}
          fill="none" stroke={ring.color} strokeWidth={1.5} strokeDasharray={ring.dashed ? '5 4' : undefined} opacity={0.7}>
          <title>{ring.title}</title>
        </rect>
      )}
      {/* Contours around the core. */}
      {[0.35, 0.62].map((f) => (
        <ellipse key={f} cx={layout.core.x} cy={layout.core.y} rx={layout.rx * f} ry={layout.ry * f}
          fill="none" stroke="var(--border-subtle)" strokeDasharray="2 5" />
      ))}

      {/* Spokes, worn by use. */}
      {stations.map((spec) => {
        const sp = spoke(layout, spec.id);
        if (!sp) return null;
        const w = spokeWidth(spec.wear);
        return (
          <g key={`spoke-${spec.id}`}>
            <line x1={sp.from.x} y1={sp.from.y} x2={sp.to.x} y2={sp.to.y} stroke="var(--border)" strokeWidth={w} strokeLinecap="round" />
            {spec.wear > 0 && (
              <line x1={sp.from.x} y1={sp.from.y} x2={sp.to.x} y2={sp.to.y}
                stroke={spec.color} strokeOpacity={0.15 + 0.5 * spec.wear} strokeWidth={w} strokeLinecap="round" />
            )}
          </g>
        );
      })}

      {/* The route: where the main loop went, oldest legs faintest. */}
      {route.slice(1).map((to, k) => {
        const from = route[k];
        const leg = legPath(layout, from.station, to.station);
        if (!leg) return null;
        const age = now - to.at;
        const opacity = legOpacity(k, route.length - 1, age, live);
        if (opacity <= 0) return null;
        const isHead = k === route.length - 2;
        return (
          <path
            // By its stations, not its time: a call repeated at one station moves the stop's time,
            // and must not re-mount the leg and replay its drawing.
            key={`leg-${k}-${from.station}-${to.station}`}
            d={leg.d}
            fill="none"
            stroke="var(--text-faint)"
            strokeWidth={isHead ? 1.5 : 1.1}
            strokeLinecap="round"
            opacity={opacity}
            {...(isHead && live && age < 2000 ? { pathLength: 1, className: 'activity-draw' } : {})}
          />
        );
      })}

      {pulses.map((p) => <PulseDot key={p.key} layout={layout} pulse={p} tint={tint.get(p.station) ?? 'var(--text-muted)'} />)}

      {/* The core: the agent, with its context window's fill when the harness reports one. */}
      <circle cx={layout.core.x} cy={layout.core.y} r={layout.hub} fill="var(--bg-raised)" stroke="var(--border-strong)" />
      <text x={layout.core.x} y={layout.core.y + 3.5} textAnchor="middle" style={{ ...FONT, fontSize: 10 }}
        fill={board.context !== undefined ? contextPctColor(board.context, 'var(--text-body)') : 'var(--text-body)'}>
        {board.context !== undefined ? `${Math.round(board.context)}%` : board.turns > 0 ? `#${board.turns}` : ''}
      </text>

      {/* The stations. */}
      {stations.map((spec) => {
        const s = layout.stations[layout.index.get(spec.id) ?? -1];
        if (!s) return null;
        const lit = spec.runs > 0 || (live && now - spec.lastStart < GLOW_MS);
        const corner = layout.node * 0.75;
        return (
          <g key={`station-${spec.id}`} opacity={spec.amount !== null || spec.runs > 0 || spec.faults > 0 ? 1 : 0.55}>
            <title>{`${spec.label}${spec.amount ? `: ${spec.amount}` : ''} · ${spec.about}`}</title>
            {lit && (
              // The theme's breath (motion primitives), on a station with a call running.
              <circle cx={s.x} cy={s.y} r={layout.node + 4} fill="none" stroke={spec.color} strokeOpacity={0.5}
                className={spec.runs > 0 ? 'layman-breathe' : undefined} />
            )}
            <circle cx={s.x} cy={s.y} r={layout.node} fill="var(--bg-card)" stroke={spec.color} strokeWidth={lit ? 1.8 : 1.1} />
            <g transform={`translate(${s.x - 7} ${s.y - 7})`} style={{ color: spec.color }}>
              <StationGlyph station={spec.glyph} size={14} decorative />
            </g>
            <text x={s.label.x} y={s.label.y} textAnchor={s.label.anchor} style={FONT} fill="var(--text-body)">
              {spec.label}
            </text>
            {spec.amount !== null && (
              <text x={s.x + layout.node} y={s.y + layout.node + 4} textAnchor="start" style={{ ...FONT, fontSize: 8.5 }} fill="var(--text-faint)">
                {spec.amount}
              </text>
            )}
            {spec.runs > 1 && (
              <text x={s.x + corner} y={s.y - corner + 3} textAnchor="middle" style={{ ...FONT, fontSize: 8.5, fontWeight: 600 }} fill={spec.color}>
                ×{spec.runs}
              </text>
            )}
            {spec.faults > 0 && (
              <g>
                <circle cx={s.x - corner} cy={s.y - corner} r={6.5} fill="var(--error)" />
                <text x={s.x - corner} y={s.y - corner + 3} textAnchor="middle" style={{ ...FONT, fontSize: 8.5, fontWeight: 700 }} fill="var(--text-on-fill)">
                  {spec.faults > 99 ? '99+' : spec.faults}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* Subagents still at work circle the Agents station. */}
      {live && agentsAt && Array.from({ length: Math.min(6, board.agents) }, (_, k) => (
        <g key={`crew-${k}`} className="activity-orbit"
          style={{ transformOrigin: `${agentsAt.x}px ${agentsAt.y}px`, animationDelay: `${(-7 * k) / Math.min(6, board.agents)}s` }}>
          <circle cx={agentsAt.x} cy={agentsAt.y - layout.node - 6} r={2.6} fill={STATION_STYLE.agents.color} />
        </g>
      ))}
    </svg>
  );
});
