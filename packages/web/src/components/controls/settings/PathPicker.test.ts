import { describe, it, expect } from 'vitest';
import { childPath } from './PathPicker.js';

describe('childPath', () => {
  it('joins in the form the server writes paths', () => {
    expect(childPath('~', 'a')).toBe('~/a');
    expect(childPath('~/a', 'b')).toBe('~/a/b');
    expect(childPath('/mnt/x/', 'b')).toBe('/mnt/x/b');
  });
});
