import type { SessionMetrics } from './types.js';

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

export function cwdBasename(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd;
}

/** "950", "1.2k", "3.4M": a token count in at most four characters' worth of digits. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Thinking's share of output, as a whole percent, or null when there was no output. Thinking is a part of output. */
export function thinkingShare(thinking: number, output: number): number | null {
  return output > 0 ? Math.round((thinking / output) * 100) : null;
}

/**
 * The tokens behind "Xin / Yout", one kind per line: input, output (of which thinking, with its
 * share), cache read, cache write. A kind the harness does not report (Claude Code sends no cache
 * or thinking totals) is left out rather than shown as 0. `thinkingOf` is the output thinking's
 * share is taken of, when not all of `totalOutputTokens` reports thinking (an aggregate with
 * Claude Code sessions in it).
 */
export function tokenBreakdown(m: Pick<SessionMetrics,
  'totalInputTokens' | 'totalOutputTokens' | 'totalCacheReadTokens' | 'totalCacheWriteTokens' | 'totalReasoningTokens'
>, thinkingOf?: number): string {
  const n = (v: number) => v.toLocaleString('en-US');
  const output = m.totalOutputTokens ?? 0;
  const lines = [`Input: ${n(m.totalInputTokens ?? 0)}`, `Output: ${n(output)}`];
  if (m.totalReasoningTokens !== undefined) {
    const share = thinkingShare(m.totalReasoningTokens, thinkingOf ?? output);
    lines.push(`  of which thinking: ${n(m.totalReasoningTokens)}${share === null ? '' : ` (${share}% of output)`}`);
  }
  if (m.totalCacheReadTokens !== undefined) lines.push(`Cache read: ${n(m.totalCacheReadTokens)}`);
  if (m.totalCacheWriteTokens !== undefined) lines.push(`Cache write: ${n(m.totalCacheWriteTokens)}`);
  return lines.join('\n');
}
