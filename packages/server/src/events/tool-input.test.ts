import { describe, it, expect } from 'vitest';
import { toolFilePath, toolLineRange, toolPathWithRange } from './tool-input.js';

describe('toolFilePath', () => {
  it("reads claude-code's file_path", () => {
    expect(toolFilePath({ file_path: '/tmp/a.ts' })).toBe('/tmp/a.ts');
  });

  it("reads pi's path", () => {
    // The regression this helper exists for: pi names the argument `path`, and
    // reading only `file_path` left every pi file call with no path anywhere —
    // no summary, raw JSON in the detail block, and nothing in access tracking.
    expect(toolFilePath({ path: '/tmp/a.ts' })).toBe('/tmp/a.ts');
  });

  it('prefers file_path when a tool sends both', () => {
    expect(toolFilePath({ file_path: '/canonical.ts', path: '/other.ts' })).toBe('/canonical.ts');
  });

  it('ignores empty and non-string values', () => {
    expect(toolFilePath({ path: '' })).toBeUndefined();
    expect(toolFilePath({ path: '   ' })).toBeUndefined();
    expect(toolFilePath({ path: 42 })).toBeUndefined();
  });

  it('returns undefined for inputs with no path at all', () => {
    expect(toolFilePath({ command: 'ls' })).toBeUndefined();
    expect(toolFilePath(undefined)).toBeUndefined();
  });

  it("declines a search tool's path, which is the directory searched", () => {
    // Grep and Glob use `path` for where to look, not what was operated on.
    // Returning it made every search in a session summarise as the same repo
    // root, hiding the pattern that says what the call was actually for.
    expect(toolFilePath({ path: '/repo', pattern: 'TODO' }, 'Grep')).toBeUndefined();
    expect(toolFilePath({ path: '/repo', pattern: '**/*.ts' }, 'Glob')).toBeUndefined();
  });

  it('still reads a path for tools that operate on one', () => {
    expect(toolFilePath({ path: '/tmp/a.ts' }, 'Read')).toBe('/tmp/a.ts');
    expect(toolFilePath({ file_path: '/tmp/a.ts' }, 'Edit')).toBe('/tmp/a.ts');
  });
});

describe('toolLineRange', () => {
  it('renders offset + limit the way pi does', () => {
    // pi's formatReadCall computes end = offset + limit - 1; this is the exact
    // call from a real session: read …/autocomplete.js:320-419.
    expect(toolLineRange({ offset: 320, limit: 100 })).toBe(':320-419');
  });

  it('treats a bare limit as starting at line 1', () => {
    expect(toolLineRange({ limit: 50 })).toBe(':1-50');
  });

  it('renders an open-ended read from an offset', () => {
    expect(toolLineRange({ offset: 200 })).toBe(':200');
  });

  it('is empty for a whole-file read, so it can be concatenated blindly', () => {
    expect(toolLineRange({ path: '/tmp/a.ts' })).toBe('');
    expect(toolLineRange(undefined)).toBe('');
  });

  it('ignores non-numeric offset and limit', () => {
    expect(toolLineRange({ offset: '320', limit: '100' })).toBe('');
  });
});

describe('toolPathWithRange', () => {
  it('joins a pi windowed read into the summary pi itself shows', () => {
    const input = {
      path: '/opt/homebrew/Cellar/pi-coding-agent/0.84.2/libexec/autocomplete.js',
      offset: 320,
      limit: 100,
    };
    expect(toolPathWithRange(input)).toBe(
      '/opt/homebrew/Cellar/pi-coding-agent/0.84.2/libexec/autocomplete.js:320-419',
    );
  });

  it('leaves a whole-file read as a bare path', () => {
    expect(toolPathWithRange({ file_path: '/tmp/a.ts' })).toBe('/tmp/a.ts');
  });

  it('returns undefined when there is no path', () => {
    expect(toolPathWithRange({ command: 'ls' })).toBeUndefined();
  });

  it('passes the tool name through to the search-tool exclusion', () => {
    expect(toolPathWithRange({ path: '/repo', pattern: 'TODO' }, 'Grep')).toBeUndefined();
  });
});
