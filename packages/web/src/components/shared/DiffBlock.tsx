import React, { useMemo } from 'react';
import { usePrintExpandable } from '../../hooks/usePrinting.js';
import { diffLines, diffPrefix } from '../../lib/line-diff.js';

interface DiffBlockProps {
  filePath?: string;
  oldText?: string;
  newText?: string;
  /** For Write (new file): show entire content as added */
  addedText?: string;
  maxLines?: number;
  /** Unboxed, for Logs: no border, no file-name bar (the row names the file), no code background. */
  flat?: boolean;
}

export function DiffBlock({ filePath, oldText, newText, addedText, maxLines = 40, flat = false }: DiffBlockProps) {
  const [expanded, setExpanded] = usePrintExpandable();

  // computeDiff is O(m×n); memoized so a re-render that only changes what is shown (expanding,
  // or every block at once on beforeprint) does not recompute it.
  const diff = useMemo(() => {
    const lines = diffLines({ oldText, newText, addedText });
    if (!lines) return null;
    let added = 0;
    let removed = 0;
    for (const l of lines) {
      if (l.type === 'add') added++;
      else if (l.type === 'remove') removed++;
    }
    return { lines, added, removed };
  }, [oldText, newText, addedText]);

  if (!diff) return null;
  const { lines, added, removed } = diff;

  const truncated = !expanded && lines.length > maxLines;
  const visible = truncated ? lines.slice(0, maxLines) : lines;

  return (
    <div className={`${flat ? 'min-w-0' : 'rounded-md overflow-hidden border border-[var(--border-strong)]'} text-[11px] font-mono`}>
      {/* Header */}
      {!flat && filePath && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--bg-card)] border-b border-[var(--border-strong)]">
          <span className="text-[var(--text-muted)] truncate">{filePath}</span>
          {added + removed > 0 && (
            <span className="text-[10px] shrink-0 ml-2">
              {added > 0 && (
                <span className="text-[var(--ok)]">+{added}</span>
              )}
              {removed > 0 && (
                <span className="text-[var(--error)] ml-1">-{removed}</span>
              )}
            </span>
          )}
        </div>
      )}

      {/* Diff lines */}
      <div className={flat ? 'overflow-x-auto' : 'overflow-x-auto bg-[var(--bg-code)]'}>
        <table className="w-full border-collapse">
          <tbody>
            {visible.map((entry, idx) => {
              const bg =
                entry.type === 'add' ? 'bg-[var(--diff-add-bg)]' :
                entry.type === 'remove' ? 'bg-[var(--diff-remove-bg)]' :
                '';
              const prefix = diffPrefix(entry.type);
              const textColor =
                entry.type === 'add' ? 'text-[var(--diff-add-text)]' :
                entry.type === 'remove' ? 'text-[var(--diff-remove-text)]' :
                'text-[var(--text-muted)]';
              const prefixColor =
                entry.type === 'add' ? 'text-[var(--ok)]' :
                entry.type === 'remove' ? 'text-[var(--error)]' :
                'text-[var(--text-faint)]';

              return (
                <tr key={idx} className={bg}>
                  {/* Old line number */}
                  <td className="select-none w-8 px-2 text-right text-[var(--text-faint)] border-r border-[color-mix(in_srgb,var(--border-strong)_50%,transparent)] align-top">
                    {entry.oldNum ?? ''}
                  </td>
                  {/* New line number */}
                  <td className="select-none w-8 px-2 text-right text-[var(--text-faint)] border-r border-[color-mix(in_srgb,var(--border-strong)_50%,transparent)] align-top">
                    {entry.newNum ?? ''}
                  </td>
                  {/* +/- prefix */}
                  <td className={`select-none w-4 text-center ${prefixColor} align-top`}>
                    {prefix}
                  </td>
                  {/* Line content */}
                  <td className={`px-2 py-0.5 whitespace-pre ${textColor} align-top`}>
                    {entry.line}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {truncated && (
          flat ? (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
              className="text-[10px] text-[var(--accent)] hover:opacity-80"
            >
              Show {lines.length - maxLines} more lines
            </button>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
              className="w-full py-1.5 text-[10px] text-[var(--info)] hover:text-[var(--code)] bg-[var(--bg-card)] border-t border-[var(--border-strong)] transition-colors"
            >
              ↓ Show {lines.length - maxLines} more lines
            </button>
          )
        )}
      </div>
    </div>
  );
}
