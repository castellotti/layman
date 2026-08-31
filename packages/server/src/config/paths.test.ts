import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { laymanDataDir, laymanDbPath, laymanConfigPath, migrateLegacyData } from './paths.js';

describe('laymanDataDir resolution', () => {
  const saved = { LAYMAN_DATA_DIR: process.env.LAYMAN_DATA_DIR, XDG_DATA_HOME: process.env.XDG_DATA_HOME };

  afterEach(() => {
    // restore
    if (saved.LAYMAN_DATA_DIR === undefined) delete process.env.LAYMAN_DATA_DIR;
    else process.env.LAYMAN_DATA_DIR = saved.LAYMAN_DATA_DIR;
    if (saved.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved.XDG_DATA_HOME;
  });

  it('defaults to ~/.local/share/layman', () => {
    delete process.env.LAYMAN_DATA_DIR;
    delete process.env.XDG_DATA_HOME;
    expect(laymanDataDir()).toBe(join(homedir(), '.local', 'share', 'layman'));
    expect(laymanDbPath()).toBe(join(homedir(), '.local', 'share', 'layman', 'layman.db'));
    expect(laymanConfigPath()).toBe(join(homedir(), '.local', 'share', 'layman', 'layman.json'));
  });

  it('honors XDG_DATA_HOME', () => {
    delete process.env.LAYMAN_DATA_DIR;
    process.env.XDG_DATA_HOME = '/custom/xdg';
    expect(laymanDataDir()).toBe(join('/custom/xdg', 'layman'));
  });

  it('LAYMAN_DATA_DIR overrides XDG_DATA_HOME', () => {
    process.env.LAYMAN_DATA_DIR = '/explicit/dir';
    process.env.XDG_DATA_HOME = '/custom/xdg';
    expect(laymanDataDir()).toBe('/explicit/dir');
  });
});

describe('migrateLegacyData', () => {
  let tmp: string;
  let legacyDir: string;
  let nextDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'layman-migrate-'));
    legacyDir = join(tmp, 'claude');
    nextDir = join(tmp, 'data', 'layman'); // deliberately not pre-created
    mkdirSync(legacyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function pairs() {
    return [
      { legacy: join(legacyDir, 'layman.db'), next: join(nextDir, 'layman.db'), label: 'database' },
      { legacy: join(legacyDir, 'layman.json'), next: join(nextDir, 'layman.json'), label: 'config' },
    ];
  }

  it('copies legacy files to the new location, creating the dir, keeping originals', () => {
    writeFileSync(join(legacyDir, 'layman.db'), 'DBDATA');
    writeFileSync(join(legacyDir, 'layman.json'), '{"k":1}');

    const msgs = migrateLegacyData(pairs());

    expect(msgs).toHaveLength(2);
    expect(readFileSync(join(nextDir, 'layman.db'), 'utf-8')).toBe('DBDATA');
    expect(readFileSync(join(nextDir, 'layman.json'), 'utf-8')).toBe('{"k":1}');
    // originals kept as backup
    expect(existsSync(join(legacyDir, 'layman.db'))).toBe(true);
    expect(existsSync(join(legacyDir, 'layman.json'))).toBe(true);
  });

  it('is a no-op when the new file already exists (never clobbers live data)', () => {
    writeFileSync(join(legacyDir, 'layman.db'), 'OLD');
    mkdirSync(nextDir, { recursive: true });
    writeFileSync(join(nextDir, 'layman.db'), 'CURRENT');

    const msgs = migrateLegacyData(pairs());

    // db skipped (already present), config skipped (no legacy) → nothing migrated
    expect(msgs).toHaveLength(0);
    expect(readFileSync(join(nextDir, 'layman.db'), 'utf-8')).toBe('CURRENT');
  });

  it('does nothing when there is no legacy data', () => {
    expect(migrateLegacyData(pairs())).toHaveLength(0);
    expect(existsSync(nextDir)).toBe(false);
  });
});
