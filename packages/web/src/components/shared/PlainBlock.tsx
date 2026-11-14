import React from 'react';
import { usePrintExpandable } from '../../hooks/usePrinting.js';

const TONE = {
  input: 'text-[11px] text-[var(--info)] whitespace-pre-wrap break-all',
  output: 'text-xs text-[var(--text)] overflow-x-auto',
  error: 'text-xs text-[var(--error)] whitespace-pre-wrap break-words',
} as const;

/** Text of an expanded Logs row, without a box: what it is shows in its type style, not in a label. */
export function PlainBlock({ text, tone, maxLines }: { text: string; tone: keyof typeof TONE; maxLines?: number }) {
  // usePrintExpandable, not useState: print hides the button, so the export must show it all.
  const [expanded, setExpanded] = usePrintExpandable();
  const lines = text.split('\n');
  const isLong = maxLines !== undefined && lines.length > maxLines;
  const shown = isLong && !expanded ? lines.slice(0, maxLines).join('\n') : text;
  return (
    <div className="min-w-0">
      <pre className={`font-mono leading-relaxed ${TONE[tone]}`}>{shown}</pre>
      {isLong && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="text-[10px] text-[var(--accent)] hover:opacity-80"
        >
          {expanded ? 'Show less' : `Show ${lines.length - maxLines!} more lines`}
        </button>
      )}
    </div>
  );
}
