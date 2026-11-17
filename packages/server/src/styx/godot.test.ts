import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { GODOT_CSP, godotBuildStatus, resolveGodotFile } from './godot.js';

const DIR = '/srv/godot';
const at = (p: string) => resolveGodotFile(DIR, `/styx/godot/${p}`);

describe('resolveGodotFile', () => {
  it('maps the empty path to index.html and nested paths into the folder', () => {
    expect(at('')).toEqual({ file: resolve(DIR, 'index.html'), type: 'text/html; charset=utf-8' });
    expect(at('index.html?x=1')?.file).toBe(resolve(DIR, 'index.html'));
    expect(at('sub/a.png')).toEqual({ file: resolve(DIR, 'sub/a.png'), type: 'image/png' });
    expect(at('index.wasm')?.type).toBe('application/wasm');
  });

  it.each(['../x.js', '%2e%2e/x.js', '..%2fx.js', 'a/../../x.js', '.env', 'x.exe', 'a\\b.js', 'a%00.js', '%zz.js', 'a//b.js', '.hidden/x.js', 'noext'])(
    'refuses %s',
    (p) => expect(at(p)).toBeNull(),
  );

  it('refuses an absolute path and a path outside the prefix', () => {
    expect(at('/etc/passwd')).toBeNull();
    expect(resolveGodotFile(DIR, '/etc/passwd')).toBeNull();
  });
});

describe('godotBuildStatus', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'godot-status-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, body = 'x') => writeFileSync(join(dir, name), body);

  it('reports an empty folder and a missing one', () => {
    const s = godotBuildStatus(dir);
    expect(s.present).toBe(false);
    expect(s.builtAt).toBeNull();
    expect(s.problems[0]).toContain('index.html');
    expect(godotBuildStatus(join(dir, 'nope')).problems[0]).toContain('does not exist');
  });

  it('reports a complete build', () => {
    for (const f of ['index.html', 'index.js', 'index.wasm', 'index.pck']) put(f, '<html></html>');
    const s = godotBuildStatus(dir);
    expect(s).toMatchObject({ present: true, dir, files: 4, problems: [] });
    expect(s.builtAt).toBeGreaterThan(0);
  });

  it('flags a build that loads scripts from another site', () => {
    for (const f of ['index.js', 'index.wasm', 'index.pck']) put(f);
    put('index.html', '<script src="https://cdn.jsdelivr.net/npm/webrtc-adapter"></script>');
    expect(godotBuildStatus(dir).problems.join()).toContain('another site');
  });
});

describe('GODOT_CSP', () => {
  it('confines requests to Layman', () => {
    expect(GODOT_CSP).toContain("connect-src 'self'");
    expect(GODOT_CSP).toContain("default-src 'self'");
  });
});
