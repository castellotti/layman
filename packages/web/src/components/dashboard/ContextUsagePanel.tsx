import React, { useMemo } from 'react';
import type { SessionMetrics } from '../../lib/types.js';
import type { SessionInfo } from '../../lib/ws-protocol.js';

interface ContextUsagePanelProps {
  sessionMetrics: Map<string, SessionMetrics>;
  sessions: SessionInfo[];
  focusedSessionId: string | null;
}

function MiniBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div
      className="rounded-full overflow-hidden"
      style={{ flex: 1, height: 5, background: 'var(--dash-bg)' }}
    >
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.min(pct, 100)}%`,
          background: color,
          transition: 'width 0.3s ease',
        }}
      />
    </div>
  );
}

function contextColor(pct: number): string {
  return pct >= 90 ? '#f85149' : pct >= 70 ? '#d29922' : 'var(--dash-accent)';
}

function rateLimitColor(pct: number): string {
  return pct >= 80 ? '#f85149' : pct >= 50 ? '#d29922' : '#8b949e';
}

export function ContextUsagePanel({
  sessionMetrics,
  sessions,
  focusedSessionId,
}: ContextUsagePanelProps) {
  const rows = useMemo(() => {
    const targetSessions = focusedSessionId
      ? sessions.filter((s) => s.sessionId === focusedSessionId)
      : sessions;

    return targetSessions
      .map((s) => {
        const m = sessionMetrics.get(s.sessionId);
        if (!m) return null;
        const hasCtx = m.contextUsedPct !== undefined;
        const has5h = m.rateLimit5hrPct !== undefined;
        const has1w = m.rateLimit7dayPct !== undefined;
        if (!hasCtx && !has5h && !has1w) return null;
        const name = s.cwd
          ? s.cwd.split('/').filter(Boolean).pop() ?? s.sessionId.slice(0, 6)
          : s.sessionId.slice(0, 6);
        return { sessionId: s.sessionId, name, m, hasCtx, has5h, has1w };
      })
      .filter(Boolean) as Array<{
        sessionId: string;
        name: string;
        m: SessionMetrics;
        hasCtx: boolean;
        has5h: boolean;
        has1w: boolean;
      }>;
  }, [sessionMetrics, sessions, focusedSessionId]);

  if (rows.length === 0) {
    return (
      <div
        style={{
          fontFamily: 'var(--dash-font-data)',
          fontSize: 10,
          color: 'var(--dash-text-muted)',
          padding: '6px 0',
        }}
      >
        No context data
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map(({ sessionId, name, m, hasCtx, has5h, has1w }) => (
        <div key={sessionId} className="flex flex-col gap-1">
          {rows.length > 1 && (
            <span
              style={{
                fontFamily: 'var(--dash-font-data)',
                fontSize: 9,
                color: 'var(--dash-text-secondary)',
              }}
            >
              {name}
            </span>
          )}
          {hasCtx && (
            <div className="flex items-center gap-1.5">
              <span
                style={{
                  fontFamily: 'var(--dash-font-data)',
                  fontSize: 8,
                  color: 'var(--dash-text-muted)',
                  width: 20,
                  flexShrink: 0,
                }}
              >
                ctx
              </span>
              <MiniBar pct={m.contextUsedPct!} color={contextColor(m.contextUsedPct!)} />
              <span
                style={{
                  fontFamily: 'var(--dash-font-data)',
                  fontSize: 9,
                  color: contextColor(m.contextUsedPct!),
                  width: 28,
                  textAlign: 'right',
                  flexShrink: 0,
                }}
              >
                {Math.round(m.contextUsedPct!)}%
              </span>
            </div>
          )}
          {has5h && (
            <div
              className="flex items-center gap-1.5"
              title={`5-hour rate limit: ${Math.round(m.rateLimit5hrPct!)}% used${m.rateLimit5hrResetsAt ? ` · Resets at ${new Date(m.rateLimit5hrResetsAt).toLocaleTimeString()}` : ''}`}
            >
              <span
                style={{
                  fontFamily: 'var(--dash-font-data)',
                  fontSize: 8,
                  color: 'var(--dash-text-muted)',
                  width: 20,
                  flexShrink: 0,
                }}
              >
                5h
              </span>
              <MiniBar pct={m.rateLimit5hrPct!} color={rateLimitColor(m.rateLimit5hrPct!)} />
              <span
                style={{
                  fontFamily: 'var(--dash-font-data)',
                  fontSize: 9,
                  color: rateLimitColor(m.rateLimit5hrPct!),
                  width: 28,
                  textAlign: 'right',
                  flexShrink: 0,
                }}
              >
                {Math.round(m.rateLimit5hrPct!)}%
              </span>
            </div>
          )}
          {has1w && (
            <div
              className="flex items-center gap-1.5"
              title={`7-day rate limit: ${Math.round(m.rateLimit7dayPct!)}% used${m.rateLimit7dayResetsAt ? ` · Resets at ${new Date(m.rateLimit7dayResetsAt).toLocaleTimeString()}` : ''}`}
            >
              <span
                style={{
                  fontFamily: 'var(--dash-font-data)',
                  fontSize: 8,
                  color: 'var(--dash-text-muted)',
                  width: 20,
                  flexShrink: 0,
                }}
              >
                1w
              </span>
              <MiniBar pct={m.rateLimit7dayPct!} color={rateLimitColor(m.rateLimit7dayPct!)} />
              <span
                style={{
                  fontFamily: 'var(--dash-font-data)',
                  fontSize: 9,
                  color: rateLimitColor(m.rateLimit7dayPct!),
                  width: 28,
                  textAlign: 'right',
                  flexShrink: 0,
                }}
              >
                {Math.round(m.rateLimit7dayPct!)}%
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
