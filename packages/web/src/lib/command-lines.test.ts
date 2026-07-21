import { describe, it, expect } from 'vitest';
import { splitCommandLines, hasSudoLine, copyAllPayload, copyLinePayload } from './command-lines.js';

describe('splitCommandLines', () => {
  it('splits a multi-line fenced block into one entry per non-blank line', () => {
    const code = 'wget https://example.com/pkg.deb\nsudo dpkg -i pkg.deb\nsudo apt-get update\nsudo apt-get install -y cuda-toolkit';
    expect(splitCommandLines(code)).toEqual([
      'wget https://example.com/pkg.deb',
      'sudo dpkg -i pkg.deb',
      'sudo apt-get update',
      'sudo apt-get install -y cuda-toolkit',
    ]);
  });

  it('drops blank lines between commands', () => {
    expect(splitCommandLines('echo one\n\n\necho two\n')).toEqual(['echo one', 'echo two']);
  });

  it('keeps a && chain as a single line, not split on the operator', () => {
    const line = 'cd /tmp && wget https://example.com/x.sh && bash x.sh';
    expect(splitCommandLines(line)).toEqual([line]);
  });
});

describe('hasSudoLine', () => {
  it('detects sudo as a standalone word', () => {
    expect(hasSudoLine(['sudo apt-get update'])).toBe(true);
    expect(hasSudoLine(['apt-get update', 'sudo reboot'])).toBe(true);
  });

  it('does not false-positive on sudo as a substring of another word', () => {
    expect(hasSudoLine(['echo pseudonymous'])).toBe(false);
    expect(hasSudoLine(['echo not-sudo-related'])).toBe(false);
  });

  it('returns false for an empty command set', () => {
    expect(hasSudoLine([])).toBe(false);
  });
});

describe('copyAllPayload / copyLinePayload', () => {
  const lines = ['wget https://example.com/pkg.deb', 'sudo dpkg -i pkg.deb', 'sudo apt-get update && sudo apt-get install -y cuda-toolkit'];

  it('copy-all joins every line exactly as displayed', () => {
    expect(copyAllPayload(lines)).toBe(lines.join('\n'));
  });

  it('per-line copy returns exactly one line, && chains intact', () => {
    expect(copyLinePayload(lines, 1)).toBe('sudo dpkg -i pkg.deb');
    expect(copyLinePayload(lines, 2)).toBe('sudo apt-get update && sudo apt-get install -y cuda-toolkit');
  });

  it('per-line copy on an out-of-range index returns an empty string', () => {
    expect(copyLinePayload(lines, 99)).toBe('');
  });
});
