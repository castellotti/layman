import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { browse, MAX_ENTRIES } from './fs-browse.js';

let root: string;
let home: string;
let data: string;
let outside: string;
const env = () => ({ home, dataDir: data });
const names = (r: { entries: { name: string }[] }) => r.entries.map((e) => e.name);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fsb-')));
  home = join(root, 'home');
  data = join(home, '.local', 'share', 'layman');
  outside = join(root, 'outside');
  mkdirSync(data, { recursive: true });
  mkdirSync(outside);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('browse', () => {
  it('lists the home folder for an empty path and for ~', () => {
    mkdirSync(join(home, 'proj'));
    expect(browse('', '', env()).path).toBe('~');
    expect(names(browse('~', '', env()))).toContain('proj');
  });

  it('walks up from a path that does not exist to the deepest folder that does', () => {
    mkdirSync(join(home, 'a'));
    const r = browse('~/a/b/c', '', env());
    expect(r.path).toBe('~/a');
    expect(r.requested).toBe('~/a/b/c');
    expect(r.requestedExists).toBe(false);
    expect(browse('~/a', '', env()).requestedExists).toBe(true);
  });

  it('lists the folder of a file it is given', () => {
    writeFileSync(join(home, 'x.mmdb'), '');
    const r = browse('~/x.mmdb', '.mmdb', env());
    expect(r.path).toBe('~');
    expect(names(r)).toContain('x.mmdb');
  });

  it('rebases a host-absolute path onto the container home', () => {
    mkdirSync(join(home, 'a'));
    const r = browse('/Users/fake/a', '', { ...env(), hostHome: '/Users/fake' });
    expect(r.path).toBe('~/a');
  });

  it('clamps a path outside the roots to home', () => {
    const r = browse(outside, '', env());
    expect(r.path).toBe('~');
    expect(r.requestedExists).toBe(false);
  });

  it('never lists above home', () => {
    expect(browse('~', '', env()).parent).toBeNull();
    expect(browse('~/.local', '', env()).parent).toBe('~');
  });

  it('allows the data folder when it lies outside home', () => {
    const d = join(root, 'xdg', 'layman');
    mkdirSync(d, { recursive: true });
    const r = browse(d, '', { home, dataDir: d });
    expect(r.path).toBe(d);
    expect(r.parent).toBeNull();
  });

  it('hides a symlink that leaves the roots and shows one that stays', () => {
    mkdirSync(join(home, 'real'));
    symlinkSync(outside, join(home, 'escape'));
    symlinkSync(join(home, 'real'), join(home, 'link'));
    const n = names(browse('~', '', env()));
    expect(n).not.toContain('escape');
    expect(n).toContain('link');
  });

  it('does not follow a symlinked path out of the roots', () => {
    symlinkSync(outside, join(home, 'escape'));
    expect(browse('~/escape', '', env()).path).toBe('~');
  });

  it('lists files only with a matching extension (case-insensitive)', () => {
    writeFileSync(join(home, 'a.MMDB'), '');
    writeFileSync(join(home, 'b.txt'), '');
    expect(names(browse('~', '.mmdb', env()))).toEqual(['.local', 'a.MMDB']);
    expect(names(browse('~', '', env()))).toEqual(['.local']);
  });

  it('sorts folders first, plain names before dot names, ignoring case', () => {
    for (const d of ['b', 'A', '.z', '.a']) mkdirSync(join(home, d));
    writeFileSync(join(home, 'f.mmdb'), '');
    expect(names(browse('~', '.mmdb', env()))).toEqual(['A', 'b', '.a', '.local', '.z', 'f.mmdb']);
  });

  it('truncates a long listing', () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) mkdirSync(join(home, `d${i}`));
    const r = browse('~', '', env());
    expect(r.truncated).toBe(true);
    expect(r.entries).toHaveLength(MAX_ENTRIES);
  });
});
