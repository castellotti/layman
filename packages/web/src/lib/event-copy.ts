import type { TimelineEvent } from './types.js';
import { toolFilePath, toolLineRange } from './tool-input.js';
import { getEffectiveAgentContent } from './reasoning.js';
import { eventDetail } from './event-styles.js';
import { diffLines, diffPrefix } from './line-diff.js';

/** An input as text, whole: the command, the path (with its line range and any content), the pattern, query, url or prompt, else the JSON. */
export function toolInputText(input: Record<string, unknown>, toolName?: string): string {
  if ('command' in input) return String(input.command);
  // File path tools. The path key differs per harness (pi uses `path`), and a
  // windowed read carries offset/limit that say which part of the file was read.
  // `toolName` is what keeps Grep/Glob out of this branch — their `path` is the
  // directory searched, and the pattern below is the identifying argument.
  const filePath = toolFilePath(input, toolName);
  if (filePath) {
    const path = `${filePath}${toolLineRange(input)}`;
    if ('content' in input) return `${path}\n${String(input.content)}`;
    return path;
  }
  if ('pattern' in input) return String(input.pattern);
  if ('query' in input) return String(input.query);
  if ('url' in input) return String(input.url);
  if ('prompt' in input) return String(input.prompt);
  return JSON.stringify(input, null, 2);
}

export interface EditDiff { filePath: string; oldText: string; newText: string }

/** The diffs an Edit or MultiEdit input holds (one, or one per entry of `edits`), shared by the body and Copy. Empty for anything else. */
export function editDiffs(input: Record<string, unknown>, toolName?: string): EditDiff[] {
  if (toolName !== 'Edit' && toolName !== 'MultiEdit') return [];
  const filePath = toolFilePath(input, toolName) ?? '';
  const one = (e: Record<string, unknown>): EditDiff => ({ filePath, oldText: String(e.old_string ?? ''), newText: String(e.new_string ?? '') });
  if ('old_string' in input) return [one(input)];
  if (Array.isArray(input.edits)) {
    return input.edits.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && 'old_string' in e).map(one);
  }
  return [];
}

/** A tool output as text: a string as is, anything else as JSON. */
export function valueText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

function listSection(label: string, items: string[] | undefined): string {
  return items && items.length > 0 ? [label, ...items].join('\n') : '';
}

/** Everything an expanded Logs row shows for an event, as source text, in the order shown. */
export function eventCopyText(event: TimelineEvent): string {
  const d = event.data;
  const sections: string[] = [];

  if (d.toolInput) {
    const input = d.toolInput as Record<string, unknown>;
    const edits = editDiffs(input, d.toolName);
    if (edits.length > 0) {
      for (const e of edits) {
        const lines = diffLines({ oldText: e.oldText, newText: e.newText }) ?? [];
        sections.push([e.filePath, ...lines.map((l) => diffPrefix(l.type) + l.line)].join('\n'));
      }
    } else {
      sections.push(toolInputText(input, d.toolName));
    }
  }

  if (event.type === 'permission_request') {
    const parts: string[] = [];
    if (d.permissionRequestType) {
      parts.push(`Permission type: ${d.permissionRequestType === 'tool_use' ? 'Tool Use' : 'Execution Mode'}`);
    }
    for (const s of (d.permissionSuggestions ?? []) as unknown as Array<Record<string, unknown>>) {
      parts.push(s.description ? String(s.description) : s.command ? String(s.command) : JSON.stringify(s));
    }
    sections.push(parts.join('\n'));
  }

  const prose = getEffectiveAgentContent(event).response;
  if (prose.trim()) sections.push(prose);

  if (d.error) sections.push(d.error);
  if (d.toolOutput !== undefined) sections.push(valueText(d.toolOutput));
  if (d.decision?.reason) sections.push(`Reason: ${d.decision.reason}`);

  if (event.type === 'drift_check' || event.type === 'drift_alert') {
    if (d.driftSummary) sections.push(d.driftSummary);
    sections.push(listSection('Indicators', d.driftIndicators));
    sections.push(listSection('Violations', d.driftViolations?.map((v) => `${v.severity} | ${v.rule} → ${v.action}`)));
    sections.push(listSection('Phantom references', d.driftPhantomRefs));
    sections.push(listSection('Pattern breaks', d.driftPatternBreaks));
  }

  if (event.type === 'web_search') {
    if (d.webSearchQueries?.length) sections.push(d.webSearchQueries.join('\n'));
    for (const s of d.webSearchSources ?? []) sections.push(`${s.title}\n${s.url}`);
  }

  if (event.type === 'subagent_stop' && d.subagentTranscript?.length) {
    const parts: string[] = [];
    for (const e of d.subagentTranscript) {
      if (e.role === 'assistant' && e.text) parts.push(e.text);
      else if (e.role === 'tool' && e.toolName) {
        const lines = [e.toolName];
        if (e.toolInput) lines.push(toolInputText(e.toolInput, e.toolName));
        if (e.toolOutput !== undefined) lines.push(valueText(e.toolOutput));
        parts.push(lines.join('\n'));
      }
    }
    sections.push(parts.join('\n\n'));
  }

  const text = sections.filter((s) => s.trim()).join('\n\n');
  return text || eventDetail(event);
}
