import React from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { SessionMetrics } from '../../lib/types.js';

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function ContextBar({ pct }: { pct: number }) {
  const color = pct >= 90 ? '#f85149' : pct >= 70 ? '#d29922' : '#238636';
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 rounded-full bg-[#21262d] overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-[10px] tabular-nums" style={{ color }}>{Math.round(pct)}%</span>
    </div>
  );
}

function RateLimitBadge({ label, pct }: { label: string; pct: number }) {
  if (pct < 50) return null;
  const color = pct >= 80 ? '#f85149' : '#d29922';
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[9px] font-medium tabular-nums"
      style={{ backgroundColor: `${color}20`, color }}
    >
      {label} {Math.round(pct)}%
    </span>
  );
}

export function SessionMetricsBar() {
  const { activeSessionId, sessionMetrics } = useSessionStore((s) => ({
    activeSessionId: s.activeSessionId,
    sessionMetrics: s.sessionMetrics,
  }));

  const isAllSessions = activeSessionId === null;

  // Single session: show that session's metrics directly
  // All sessions: aggregate summable fields across all sessions
  let metrics: SessionMetrics | undefined;
  if (activeSessionId) {
    metrics = sessionMetrics.get(activeSessionId);
  } else if (sessionMetrics.size > 0) {
    let totalCost = 0;
    let totalIn = 0;
    let totalOut = 0;
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    let latestTimestamp = 0;
    let hasCost = false;
    let hasTokens = false;
    let hasLines = false;

    for (const [, m] of sessionMetrics) {
      if (m.costUsd !== undefined) { totalCost += m.costUsd; hasCost = true; }
      if ((m.totalInputTokens ?? 0) > 0 || (m.totalOutputTokens ?? 0) > 0) {
        totalIn += m.totalInputTokens ?? 0;
        totalOut += m.totalOutputTokens ?? 0;
        hasTokens = true;
      }
      if ((m.linesAdded ?? 0) > 0 || (m.linesRemoved ?? 0) > 0) {
        totalLinesAdded += m.linesAdded ?? 0;
        totalLinesRemoved += m.linesRemoved ?? 0;
        hasLines = true;
      }
      if (m.timestamp > latestTimestamp) latestTimestamp = m.timestamp;
    }

    metrics = {
      costUsd: hasCost ? totalCost : undefined,
      totalInputTokens: hasTokens ? totalIn : undefined,
      totalOutputTokens: hasTokens ? totalOut : undefined,
      linesAdded: hasLines ? totalLinesAdded : undefined,
      linesRemoved: hasLines ? totalLinesRemoved : undefined,
      timestamp: latestTimestamp,
    };
  }

  if (!metrics) return null;

  const hasContext = !isAllSessions && metrics.contextUsedPct !== undefined;
  const hasCost = metrics.costUsd !== undefined;
  const hasTokens = (metrics.totalInputTokens ?? 0) > 0 || (metrics.totalOutputTokens ?? 0) > 0;
  const hasLines = (metrics.linesAdded ?? 0) > 0 || (metrics.linesRemoved ?? 0) > 0;

  return (
    <div className="flex items-center gap-3 px-3 py-1 bg-[#0d1117] border-b border-[#21262d] text-[10px] text-[#8b949e] flex-wrap" data-print-hide>
      {/* Model badge — single session only */}
      {!isAllSessions && metrics.modelDisplayName && (
        <span className="px-1.5 py-0.5 rounded bg-[#21262d] text-[#e6edf3] font-medium">
          {metrics.modelDisplayName}
        </span>
      )}

      {/* "All sessions" label when aggregating */}
      {isAllSessions && sessionMetrics.size > 1 && (
        <span className="text-[#484f58]">{sessionMetrics.size} sessions</span>
      )}

      {/* Context window fill */}
      {hasContext && (
        <div className="flex items-center gap-1" title="Context window usage">
          <span className="text-[#484f58]">ctx</span>
          <ContextBar pct={metrics.contextUsedPct!} />
        </div>
      )}

      {/* Cost */}
      {hasCost && (
        <span className="tabular-nums" title="Session cost">
          {formatCost(metrics.costUsd!)}
        </span>
      )}

      {/* Tokens */}
      {hasTokens && (
        <span className="tabular-nums" title={`Input: ${metrics.totalInputTokens?.toLocaleString() ?? 0} / Output: ${metrics.totalOutputTokens?.toLocaleString() ?? 0}`}>
          {formatTokens(metrics.totalInputTokens ?? 0)}in / {formatTokens(metrics.totalOutputTokens ?? 0)}out
        </span>
      )}

      {/* Lines changed */}
      {hasLines && (
        <span className="tabular-nums">
          <span className="text-[#3fb950]">+{metrics.linesAdded ?? 0}</span>
          {' '}
          <span className="text-[#f85149]">-{metrics.linesRemoved ?? 0}</span>
        </span>
      )}

      {/* Rate limit warnings — single session only */}
      {!isAllSessions && metrics.rateLimit5hrPct !== undefined && (
        <RateLimitBadge label="5h" pct={metrics.rateLimit5hrPct} />
      )}
      {!isAllSessions && metrics.rateLimit7dayPct !== undefined && (
        <RateLimitBadge label="7d" pct={metrics.rateLimit7dayPct} />
      )}
    </div>
  );
}
