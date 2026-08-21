/**
 * Shared markdown serialization for turns and sessions.
 *
 * Used by `GET /api/turns/...?format=md`, by the Obsidian vault exporter, and by
 * any future clipboard/print path.  Deliberately pure and filesystem-free — the
 * exporter owns frontmatter, filenames and I/O.
 */
import type { TimelineEvent } from '../events/types.js';
import type { RecordedSession } from '../db/types.js';
import type { Turn } from '../turns/types.js';
import { TOOL_CALL_TYPES } from '../turns/extract.js';
import { buildUrl } from './urls.js';
import { toolPathWithRange } from '../events/tool-input.js';

export interface MarkdownOpts {
  /** Base URL of the instance, for "Open in Layman" links. */
  instanceUrl: string;
  includeToolCalls: 'none' | 'summary' | 'full';
  includeAnalysis: boolean;
  /** Heading level for a turn's own heading (2 → "## Turn"). */
  headingLevel?: number;
  /** Emit `^turn-xxxxxxxx` block anchors for intra-vault linking. */
  blockAnchors?: boolean;
}

const DEFAULT_OPTS = { headingLevel: 2, blockAnchors: false } as const;

/** First line of a string, trimmed and length-capped — for headings and summaries. */
export function firstLine(text: string, max = 80): string {
  const line = (text ?? '').split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function pad(level: number): string {
  return '#'.repeat(Math.min(Math.max(level, 1), 6));
}

/** Blockquote a possibly multi-line string. */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function formatDuration(startedAt: number, endedAt: number | null): string {
  if (endedAt === null) return '—';
  const secs = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return secs % 60 === 0 ? `${mins}m` : `${mins}m ${secs % 60}s`;
}

/**
 * A one-line description of a tool call: the most identifying argument we can
 * find, truncated. Covers Bash/Read/Write/Edit/Glob/Grep/WebFetch shapes without
 * hardcoding a per-tool table.
 */
export function describeToolCall(event: TimelineEvent, max = 120): string {
  const input = event.data.toolInput ?? {};
  const truncate = (value: string): string => {
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };

  // Order matches formatToolInput() in packages/web/src/components/events/EventCard.tsx —
  // keep them identical or an export and the live dashboard will summarize the same
  // tool call input differently.
  if (typeof input.command === 'string' && input.command.trim()) return truncate(input.command);

  // Resolved through the shared helper rather than a literal key, because the
  // path argument is named differently per harness (pi uses `path`), and a
  // windowed read carries the line range that says what was actually looked at.
  const path = toolPathWithRange(input);
  if (path) return truncate(path);

  for (const key of ['pattern', 'query', 'url', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return truncate(value);
  }
  return '';
}

function renderToolCalls(events: TimelineEvent[], opts: MarkdownOpts): string {
  if (opts.includeToolCalls === 'none') return '';

  const calls = events.filter((e) => TOOL_CALL_TYPES.has(e.type));
  if (calls.length === 0) return '';

  const lines = calls.map((event) => {
    const name = event.data.toolName ?? event.type;
    const failed = event.type === 'tool_call_failed' || event.type === 'tool_call_denied';
    const marker = failed ? ` _(${event.type === 'tool_call_denied' ? 'denied' : 'failed'})_` : '';

    if (opts.includeToolCalls === 'summary') {
      const desc = describeToolCall(event);
      return `- \`${name}\`${desc ? ` — ${desc}` : ''}${marker}`;
    }

    // 'full' — inputs and outputs in fenced blocks.
    const input = JSON.stringify(event.data.toolInput ?? {}, null, 2);
    const output = event.data.toolOutput === undefined
      ? ''
      : `\n\n\`\`\`\n${typeof event.data.toolOutput === 'string' ? event.data.toolOutput : JSON.stringify(event.data.toolOutput, null, 2)}\n\`\`\``;
    return `- \`${name}\`${marker}\n\n\`\`\`json\n${input}\n\`\`\`${output}`;
  });

  return [
    `<details>`,
    `<summary>Tool calls (${calls.length})</summary>`,
    ``,
    lines.join('\n'),
    ``,
    `</details>`,
  ].join('\n');
}

function renderExplanation(events: TimelineEvent[], opts: MarkdownOpts): string {
  if (!opts.includeAnalysis) return '';

  // Prefer the layman's explanation attached to the turn's own response; fall
  // back to the most recent one attached to any owned event.
  const withLaymans = events.filter((e) => e.laymans?.explanation);
  if (withLaymans.length === 0) return '';

  const explanation = withLaymans[withLaymans.length - 1].laymans!.explanation.trim();
  if (!explanation) return '';

  // Obsidian callout: the header line and the body share the blockquote.
  return ['> [!info] In plain English', quote(explanation)].join('\n');
}

/** One turn, as a markdown section. */
export function turnToMarkdown(turn: Turn, events: TimelineEvent[], opts: MarkdownOpts): string {
  const level = opts.headingLevel ?? DEFAULT_OPTS.headingLevel;
  const anchor = (opts.blockAnchors ?? DEFAULT_OPTS.blockAnchors)
    ? `  ^turn-${shortId(turn.promptEventId)}`
    : '';

  const turnUrl = buildUrl(opts.instanceUrl, {
    kind: 'turn',
    sessionId: turn.sessionId,
    promptEventId: turn.promptEventId,
  });
  const playUrl = buildUrl(
    opts.instanceUrl,
    { kind: 'turn', sessionId: turn.sessionId, promptEventId: turn.promptEventId },
    { play: true },
  );

  const meta = [
    `[Open turn](${turnUrl})`,
    `${formatTime(turn.startedAt)}→${turn.endedAt ? formatTime(turn.endedAt) : '—'}`,
    `${formatDuration(turn.startedAt, turn.endedAt)}`,
    `${turn.toolCallCount} tool ${turn.toolCallCount === 1 ? 'call' : 'calls'}`,
    `[🔊](${playUrl})`,
  ].join(' · ');

  const sections = [
    `${pad(level)} ${turn.index + 1} · ${firstLine(turn.promptText) || '(empty prompt)'}${anchor}`,
    ``,
    meta,
    ``,
    quote(turn.promptText.trim() || '(empty prompt)'),
  ];

  if (turn.responseText.trim()) {
    sections.push(``, `**Response**`, ``, turn.responseText.trim());
  } else {
    sections.push(``, `_No agent response recorded for this turn._`);
  }

  const explanation = renderExplanation(events, opts);
  if (explanation) sections.push(``, explanation);

  const toolCalls = renderToolCalls(events, opts);
  if (toolCalls) sections.push(``, toolCalls);

  return sections.join('\n');
}

/** A whole session: title, instance link, then every turn. */
export function sessionToMarkdown(
  session: RecordedSession,
  turns: Turn[],
  events: TimelineEvent[],
  opts: MarkdownOpts,
): string {
  const level = opts.headingLevel ?? DEFAULT_OPTS.headingLevel;
  const byId = new Map(events.map((e) => [e.id, e]));
  const title = session.sessionName?.trim() || session.cwd.split('/').filter(Boolean).pop() || shortId(session.sessionId);

  const sessionUrl = buildUrl(opts.instanceUrl, { kind: 'session', sessionId: session.sessionId });

  const head = [
    `${pad(level - 1 > 0 ? level - 1 : 1)} ${title}`,
    ``,
    `[Open in Layman](${sessionUrl})`,
  ];

  if (turns.length === 0) {
    return [...head, ``, `_No turns recorded in this session._`, ``].join('\n');
  }

  const body = turns.map((turn) => {
    const owned = turn.eventIds.map((id) => byId.get(id)).filter((e): e is TimelineEvent => !!e);
    return turnToMarkdown(turn, owned, opts);
  });

  return [...head, ``, body.join('\n\n')].join('\n').replace(/\n{3,}$/, '\n');
}
