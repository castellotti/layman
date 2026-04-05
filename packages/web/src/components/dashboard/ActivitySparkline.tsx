import React, { useMemo } from 'react';
import type { TimelineEvent } from '../../lib/types.js';
import type { SessionInfo } from '../../lib/ws-protocol.js';
import { AGENT_BADGES } from '../../lib/event-styles.js';

interface ActivitySparklineProps {
  events: TimelineEvent[];
  sessions: SessionInfo[];
  focusedSessionId: string | null;
  /** Number of time buckets */
  buckets?: number;
  /** Height of the chart */
  height?: number;
}

/** Map sessionId → a consistent color */
function getSessionColor(sessionId: string, sessions: SessionInfo[]): string {
  const session = sessions.find(s => s.sessionId === sessionId);
  if (session) {
    const badge = AGENT_BADGES[session.agentType];
    if (badge) {
      // Extract hex from tailwind class like 'text-[#a371f7] ...'
      const match = badge.color.match(/#[0-9a-fA-F]{6}/);
      if (match) return match[0];
    }
  }
  // Fallback colors
  const fallback = ['#00e5ff', '#ffb300', '#ff3d57', '#00e676', '#a371f7', '#f0883e'];
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
  return fallback[Math.abs(hash) % fallback.length];
}

export function ActivitySparkline({
  events,
  sessions,
  focusedSessionId,
  buckets = 40,
  height = 64,
}: ActivitySparklineProps) {
  const chartData = useMemo(() => {
    if (events.length === 0) return null;

    // Filter out noise events
    const meaningful = events.filter(e =>
      e.type !== 'session_metrics' && e.type !== 'notification'
    );
    if (meaningful.length === 0) return null;

    const now = Date.now();
    const minTime = meaningful[0].timestamp;
    const range = now - minTime;
    if (range <= 0) return null;

    const bucketWidth = range / buckets;

    // Group by session
    const sessionIds = focusedSessionId
      ? [focusedSessionId]
      : [...new Set(meaningful.map(e => e.sessionId))];

    // Build bucket counts per session
    const sessionBuckets: Map<string, number[]> = new Map();
    for (const sid of sessionIds) {
      sessionBuckets.set(sid, new Array(buckets).fill(0));
    }

    for (const event of meaningful) {
      if (!sessionBuckets.has(event.sessionId)) continue;
      const idx = Math.min(
        Math.floor((event.timestamp - minTime) / bucketWidth),
        buckets - 1
      );
      sessionBuckets.get(event.sessionId)![idx]++;
    }

    // Find max for scaling
    let maxCount = 0;
    for (let b = 0; b < buckets; b++) {
      let total = 0;
      for (const counts of sessionBuckets.values()) total += counts[b];
      maxCount = Math.max(maxCount, total);
    }

    return { sessionIds, sessionBuckets, maxCount, minTime, bucketWidth };
  }, [events, focusedSessionId, buckets]);

  if (!chartData || chartData.maxCount === 0) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontFamily: 'var(--dash-font-data)', fontSize: 10, color: 'var(--dash-text-muted)' }}>
          No activity data
        </span>
      </div>
    );
  }

  const { sessionIds, sessionBuckets, maxCount } = chartData;
  const barWidth = 100 / buckets;
  const barGap = 0.3;

  return (
    <svg width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none">
      {/* Bars — stacked per session */}
      {Array.from({ length: buckets }).map((_, b) => {
        let yOffset = height;
        return (
          <g key={b}>
            {sessionIds.map(sid => {
              const count = sessionBuckets.get(sid)?.[b] ?? 0;
              if (count === 0) return null;
              const barH = (count / maxCount) * (height - 4);
              yOffset -= barH;
              const color = getSessionColor(sid, sessions);
              return (
                <rect
                  key={sid}
                  x={b * barWidth + barGap / 2}
                  y={yOffset}
                  width={barWidth - barGap}
                  height={barH}
                  fill={color}
                  opacity={focusedSessionId && sid !== focusedSessionId ? 0.2 : 0.7}
                  className="dash-sparkline-bar"
                />
              );
            })}
          </g>
        );
      })}
      {/* Zero line */}
      <line x1="0" y1={height - 0.5} x2="100" y2={height - 0.5} stroke="var(--dash-border-subtle)" strokeWidth="0.5" />
    </svg>
  );
}
