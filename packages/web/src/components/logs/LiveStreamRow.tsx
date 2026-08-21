import React from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { LiveStream } from '../../lib/types.js';

/**
 * How much of each buffer to show. The store keeps 32 KB so a stream can be
 * inspected, but a log row is not a transcript — the interesting part of live
 * output is always the end of it.
 */
const VISIBLE_TAIL_CHARS = 1200;

function tail(text: string): string {
  return text.length <= VISIBLE_TAIL_CHARS ? text : `…${text.slice(-VISIBLE_TAIL_CHARS)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Blinking caret marking the live edge of generation. */
function Cursor() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 6,
        height: 12,
        marginLeft: 2,
        verticalAlign: 'text-bottom',
        background: 'var(--accent)',
        animation: 'layman-blink 1s steps(2, start) infinite',
      }}
    />
  );
}

/**
 * The tail of the log stream while an agent is generating.
 *
 * Renders nothing at all when there is no live stream for the session — which
 * is the permanent state for the four harnesses with no streaming hook. Its
 * absence must never show as an empty or stuck row.
 */
export function LiveStreamRow({ sessionId }: { sessionId: string | null }) {
  const { liveStreams, config } = useSessionStore((s) => ({
    liveStreams: s.liveStreams,
    config: s.config,
  }));

  if (!sessionId) return null;
  if (config && config.liveTokens?.enabled === false) return null;

  const stream: LiveStream | undefined = liveStreams.get(sessionId);
  if (!stream) return null;

  const showThinking = config?.liveTokens?.showThinking !== false;
  const thinking = showThinking ? stream.thinking : '';
  const hasAny = stream.text || thinking;
  if (!hasAny && stream.tokens.output === 0) return null;

  return (
    <div
      data-print-hide
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '6px 10px',
        borderLeft: '2px solid var(--accent)',
        background: 'var(--bg-card)',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        lineHeight: 1.55,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-faint)', fontSize: 10 }}>
        <span style={{ color: 'var(--accent)' }}>
          {stream.phase === 'thinking' ? 'thinking' : 'responding'}
        </span>
        {stream.model && <span>{stream.model}</span>}
        {stream.tokens.output > 0 && (
          <span className="tabular-nums">{formatTokens(stream.tokens.output)} out</span>
        )}
      </div>

      {/* Reasoning gets the same de-emphasised treatment as a committed
          thinking block, so the eye goes to the answer rather than the notes. */}
      {thinking && (
        <div style={{ color: 'var(--text-faint)', fontStyle: 'italic', whiteSpace: 'pre-wrap', opacity: 0.8 }}>
          {tail(thinking)}
          {stream.phase === 'thinking' && <Cursor />}
        </div>
      )}

      {stream.text && (
        <div style={{ color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
          {tail(stream.text)}
          {stream.phase !== 'thinking' && <Cursor />}
        </div>
      )}
    </div>
  );
}
