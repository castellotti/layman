import { describe, it, expect } from 'vitest';
import { diffLines, diffPrefix } from './line-diff.js';

describe('diffLines', () => {
  it('diffs an edit that changes one line of three', () => {
    const d = diffLines({ oldText: 'a\nb\nc', newText: 'a\nB\nc' })!;
    expect(d.map((l) => l.type)).toEqual(['same', 'remove', 'add', 'same']);
    expect(d[1]).toMatchObject({ line: 'b', oldNum: 2 });
    expect(d[2]).toMatchObject({ line: 'B', newNum: 2 });
    expect(d[3]).toMatchObject({ oldNum: 3, newNum: 3 });
  });

  it('adds every line of a new file', () => {
    const d = diffLines({ addedText: 'x\ny' })!;
    expect(d).toEqual([
      { type: 'add', line: 'x', newNum: 1 },
      { type: 'add', line: 'y', newNum: 2 },
    ]);
  });

  it('is null when nothing is given', () => {
    expect(diffLines({})).toBeNull();
    expect(diffLines({ oldText: 'a' })).toBeNull();
  });
});

describe('diffPrefix', () => {
  it('marks each type', () => {
    expect(diffPrefix('add')).toBe('+');
    expect(diffPrefix('remove')).toBe('-');
    expect(diffPrefix('same')).toBe(' ');
  });
});
