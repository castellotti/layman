import React, { useMemo } from 'react';
import type { TimelineEvent } from '../../lib/types.js';
import type { SessionInfo } from '../../lib/ws-protocol.js';
import { AGENT_BADGES } from '../../lib/event-styles.js';

interface EventDensityTimelineProps {
  events: TimelineEvent[];
  sessions: SessionInfo[];
  focusedSessionId: string | null;
  height?: number;
}

function getSessionColor(sessionId: string, sessions: SessionInfo[]): string {
  const session = sessions.find(s => s.sessionId === sessionId);
  if (session) {
    const badge = AGENT_BADGES[session.agentType];
    if (badge) {
      const match = badge.color.match(/#[0-9a-fA-F]{6}/);
      if (match) return match[0];
    }
  }
  const fallback = ['#00e5ff', '#ffb300', '#ff3d57', '#00e676', '#a371f7', '#f0883e'];
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
  return fallback[Math.abs(hash) % fallback.length];
}

/**
 * A zoomed-out density view of all sessions' activity.
 * Each session gets a horizontal swim lane showing event density as a heat-stripe.
 */
export function EventDensityTimeline({
  events,
  sessions,
  focusedSessionId,
  height = 100,
}: EventDensityTimelineProps) {
  const chartData = useMemo(() => {
    if (events.length === 0) return null;

    const meaningful = events.filter(e =>
      e.type !== 'session_metrics' && e.type !== 'notification'
    );
    if (meaningful.length === 0) return null;

    const now = Date.now();
    const minTime = meaningful[0].timestamp;
    const range = now - minTime;
    if (range <= 0) return null;

    const buckets = 60;
    const bucketWidth = range / buckets;

    const targetSessions = focusedSessionId
      ? sessions.filter(s => s.sessionId === focusedSessionId)
      : sessions;

    const lanes: Array<{
      sessionId: string;
      name: string;
      color: string;
      density: number[];
      isActive: boolean;
      riskBuckets: number[]; // risk events per bucket
    }> = [];

    for (const session of targetSessions) {
      const sessionEvents = meaningful.filter(e => e.sessionId === session.sessionId);
      if (sessionEvents.length === 0) continue;

      const density = new Array(buckets).fill(0);
      const riskBuckets = new Array(buckets).fill(0);
      for (const event of sessionEvents) {
        const idx = Math.min(Math.floor((event.timestamp - minTime) / bucketWidth), buckets - 1);
        density[idx]++;
        if (event.riskLevel === 'medium' || event.riskLevel === 'high') {
          riskBuckets[idx]++;
        }
      }

      const name = session.cwd
        ? session.cwd.split('/').filter(Boolean).pop() ?? session.sessionId.slice(0, 6)
        : session.sessionId.slice(0, 6);

      lanes.push({
        sessionId: session.sessionId,
        name,
        color: getSessionColor(session.sessionId, sessions),
        density,
        isActive: session.active !== false,
        riskBuckets,
      });
    }

    // Global max for consistent scaling
    let maxDensity = 0;
    for (const lane of lanes) {
      for (const d of lane.density) maxDensity = Math.max(maxDensity, d);
    }

    return { lanes, maxDensity, buckets, minTime, range };
  }, [events, sessions, focusedSessionId]);

  if (!chartData || chartData.lanes.length === 0) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontFamily: 'var(--dash-font-data)', fontSize: 10, color: 'var(--dash-text-muted)' }}>
          No timeline data
        </span>
      </div>
    );
  }

  const { lanes, maxDensity, buckets } = chartData;
  const laneHeight = Math.min(16, (height - 16) / lanes.length - 2);

  return (
    <div className="flex flex-col gap-1">
      {lanes.map((lane) => (
        <div key={lane.sessionId} className="flex items-center gap-2">
          {/* Label */}
          <span
            style={{
              fontFamily: 'var(--dash-font-data)',
              fontSize: 8,
              color: lane.color,
              width: 48,
              flexShrink: 0,
              textAlign: 'right',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {lane.name}
          </span>
          {/* Activity status */}
          <div
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{
              background: lane.isActive ? 'var(--dash-success)' : 'var(--dash-text-muted)',
              boxShadow: lane.isActive ? '0 0 4px var(--dash-success)' : 'none',
            }}
          />
          {/* Heat stripe */}
          <svg
            className="flex-1"
            height={laneHeight}
            viewBox={`0 0 ${buckets} ${laneHeight}`}
            preserveAspectRatio="none"
          >
            {lane.density.map((d, i) => {
              if (d === 0) return null;
              const intensity = maxDensity > 0 ? d / maxDensity : 0;
              const hasRisk = lane.riskBuckets[i] > 0;
              return (
                <rect
                  key={i}
                  x={i}
                  y={0}
                  width={1}
                  height={laneHeight}
                  fill={hasRisk ? 'var(--dash-medium)' : lane.color}
                  opacity={0.15 + intensity * 0.7}
                />
              );
            })}
          </svg>
        </div>
      ))}
      {/* Time axis */}
      <div className="flex justify-between pl-14" style={{ fontFamily: 'var(--dash-font-data)', fontSize: 8, color: 'var(--dash-text-muted)' }}>
        <span>{formatDuration(chartData.range)}</span>
        <span>now</span>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${(ms / 3_600_000).toFixed(1)}h ago`;
}
