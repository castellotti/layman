export interface DiffLine {
  type: 'same' | 'remove' | 'add';
  line: string;
  oldNum?: number;
  newNum?: number;
}

/** Myers-style LCS line diff */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
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

/** The lines a diff block shows: an LCS diff of old/new, or every line added for a new file. */
export function diffLines(src: { oldText?: string; newText?: string; addedText?: string }): DiffLine[] | null {
  if (src.addedText !== undefined) {
    // Write / new file — all lines are added
    return src.addedText.split('\n').map((line, i) => ({ type: 'add' as const, line, newNum: i + 1 }));
  }
  if (src.oldText !== undefined && src.newText !== undefined) return computeDiff(src.oldText, src.newText);
  return null;
}

/** '+', '-' or ' ' for a line. */
export function diffPrefix(type: DiffLine['type']): string {
  return type === 'add' ? '+' : type === 'remove' ? '-' : ' ';
}
