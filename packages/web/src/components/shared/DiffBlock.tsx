import React, { useState } from 'react';

interface DiffLine {
  type: 'same' | 'remove' | 'add';
  line: string;
  oldNum?: number;
  newNum?: number;
}

/** Myers-style LCS line diff */
function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;

  // LCS DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack
  const result: Array<{ type: 'same' | 'remove' | 'add'; line: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: 'same', line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'add', line: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'remove', line: oldLines[i - 1] });
      i--;
    }
  }

  // Attach line numbers
  let oldNum = 1, newNum = 1;
  return result.map((r) => {
    const entry: DiffLine = { ...r };
    if (r.type === 'remove') { entry.oldNum = oldNum++; }
    else if (r.type === 'add') { entry.newNum = newNum++; }
    else { entry.oldNum = oldNum++; entry.newNum = newNum++; }
    return entry;
  });
}

interface DiffBlockProps {
  filePath?: string;
  oldText?: string;
  newText?: string;
  /** For Write (new file): show entire content as added */
  addedText?: string;
  maxLines?: number;
}

export function DiffBlock({ filePath, oldText, newText, addedText, maxLines = 40 }: DiffBlockProps) {
  const [expanded, setExpanded] = useState(false);

  let lines: DiffLine[];

  if (addedText !== undefined) {
    // Write / new file — all lines are added
    lines = addedText.split('\n').map((line, i) => ({
      type: 'add' as const,
      line,
      newNum: i + 1,
    }));
  } else if (oldText !== undefined && newText !== undefined) {
    lines = computeDiff(oldText, newText);
  } else {
    return null;
  }

  const changed = lines.filter((l) => l.type !== 'same').length;
  const truncated = !expanded && lines.length > maxLines;
  const visible = truncated ? lines.slice(0, maxLines) : lines;

  return (
    <div className="rounded-md overflow-hidden border border-[#30363d] text-[11px] font-mono">
      {/* Header */}
      {filePath && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-[#161b22] border-b border-[#30363d]">
          <span className="text-[#8b949e] truncate">{filePath}</span>
          {changed > 0 && (
            <span className="text-[10px] shrink-0 ml-2">
              {lines.filter((l) => l.type === 'add').length > 0 && (
                <span className="text-[#3fb950]">+{lines.filter((l) => l.type === 'add').length}</span>
              )}
              {lines.filter((l) => l.type === 'remove').length > 0 && (
                <span className="text-[#f85149] ml-1">-{lines.filter((l) => l.type === 'remove').length}</span>
              )}
            </span>
          )}
        </div>
      )}

      {/* Diff lines */}
      <div className="overflow-x-auto bg-[#0d1117]">
        <table className="w-full border-collapse">
          <tbody>
            {visible.map((entry, idx) => {
              const bg =
                entry.type === 'add' ? 'bg-[#0f2a1a]' :
                entry.type === 'remove' ? 'bg-[#2a0f0f]' :
                '';
              const prefix =
                entry.type === 'add' ? '+' :
                entry.type === 'remove' ? '-' :
                ' ';
              const textColor =
                entry.type === 'add' ? 'text-[#aff5b4]' :
                entry.type === 'remove' ? 'text-[#ffc0c0]' :
                'text-[#8b949e]';
              const prefixColor =
                entry.type === 'add' ? 'text-[#3fb950]' :
                entry.type === 'remove' ? 'text-[#f85149]' :
                'text-[#484f58]';

              return (
                <tr key={idx} className={bg}>
                  {/* Old line number */}
                  <td className="select-none w-8 px-2 text-right text-[#484f58] border-r border-[#30363d]/50 align-top">
                    {entry.oldNum ?? ''}
                  </td>
                  {/* New line number */}
                  <td className="select-none w-8 px-2 text-right text-[#484f58] border-r border-[#30363d]/50 align-top">
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
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
            className="w-full py-1.5 text-[10px] text-[#58a6ff] hover:text-[#79c0ff] bg-[#161b22] border-t border-[#30363d] transition-colors"
          >
            ↓ Show {lines.length - maxLines} more lines
          </button>
        )}
      </div>
    </div>
  );
}
