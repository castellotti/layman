/**
 * Pure line-splitting/copy-payload logic for CommandBlock, kept separate from
 * the component so it's directly unit-testable without rendering.
 */

/** Splits a shell command block into displayable/copyable lines, dropping blank lines. */
export function splitCommandLines(code: string): string[] {
  return code.split('\n').filter((line) => line.trim().length > 0);
}

/** Whether any line requires elevated privileges (drives the sudo header notice). */
export function hasSudoLine(lines: string[]): boolean {
  return lines.some((line) => /(^|\s)sudo(\s|$)/.test(line));
}

/** Copy-all payload — the lines exactly as displayed, joined by newlines. */
export function copyAllPayload(lines: string[]): string {
  return lines.join('\n');
}

/** Per-line copy payload — the single line exactly as displayed (e.g. an `&&` chain intact). */
export function copyLinePayload(lines: string[], index: number): string {
  return lines[index] ?? '';
}
