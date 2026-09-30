import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NetSessionSource, controlPaths, toHostPath } from './discovery.js';
import { addGloveSession, registerRow } from './testing/glove-home.js';
import { groupKeyFor, isIpLiteral, registrableDomain } from './domain.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'netobs-disc-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('control paths', () => {
  it('is control/<id>/rules.json', () => {
    expect(controlPaths('/h/.glove', 'pi-search-0f1a2b')).toEqual({
      controlDir: '/h/.glove/control/pi-search-0f1a2b',
      rulesPath: '/h/.glove/control/pi-search-0f1a2b/rules.json',
    });
  });
  it.each(['..', 'a/b', '', '.hidden', 'a\\b', 'pi-search', 'Pi-search-0f1a2b', 'pi-search-0F1A2B', 'x-0f1a2'])(
    'refuses anything that is not a glove id: %j',
    (id) => {
      expect(controlPaths('/h/.glove', id)).toBeNull();
    },
  );
});

describe('toHostPath', () => {
  it('translates a container path back to the host home', () => {
    expect(toHostPath('/root/.glove/control/x-0f1a2b/rules.json', '/Users/you', '/root')).toBe('/Users/you/.glove/control/x-0f1a2b/rules.json');
  });
  it('is a no-op natively, and for paths outside the home', () => {
    expect(toHostPath('/home/u/.glove/x', undefined, '/home/u')).toBe('/home/u/.glove/x');
    expect(toHostPath('/tmp/x', '/Users/alice', '/root')).toBe('/tmp/x');
    expect(toHostPath('/rootless/x', '/Users/alice', '/root')).toBe('/rootless/x');
  });
});

describe('NetSessionSource', () => {
  it('finds every observe export with a net/ dir, keyed by id, and nothing else', () => {
    addGloveSession(home, 'pi-search-0f1a2b');
    addGloveSession(home, 'review-a1b2c3', { filter: false });
    mkdirSync(join(home, 'observe', 'no-net-000000'), { recursive: true }); // no net/
    mkdirSync(join(home, 'observe', 'bad name', 'net'), { recursive: true });
    writeFileSync(join(home, 'observe', 'stray.txt'), '');
    const found = new NetSessionSource(() => home).discover();
    expect(found.registry.state).toBe('ok');
    expect(found.sessions.map((s) => s.loc.token)).toEqual(['pi-search-0f1a2b', 'review-a1b2c3']);
    const review = found.sessions[1];
    expect(review.loc.netDir).toBe(join(home, 'observe', 'review-a1b2c3', 'net'));
    expect(review.loc.rulesPath).toBe(join(home, 'control', 'review-a1b2c3', 'rules.json'));
    expect(review.info.grants.filter).toEqual({ granted: false, since: null });
    expect(found.sessions[0].info).toMatchObject({ harness: 'pi', template: 'pi-search', orphaned: null });
  });
  it('session.json grants win over the registry row; the registry names the harness', () => {
    const s = addGloveSession(home, 'pi-search-0f1a2b', { harness: 'vibe' });
    writeFileSync(join(s.net, 'session.json'), JSON.stringify({ v: 1, harness: 'pi', grants: { observe: { net: true, transcripts: false }, filter: { granted: false } } }));
    const [found] = new NetSessionSource(() => home).discover().sessions;
    expect(found.info.harness).toBe('vibe');
    expect(found.info.grants.filter?.granted).toBe(false);
  });
  it('an export with no registry row is an orphan (glove gc would remove it)', () => {
    addGloveSession(home, 'a-000000');
    addGloveSession(home, 'gone-111111', { registered: false });
    const found = new NetSessionSource(() => home).discover().sessions;
    expect(found.map((f) => [f.loc.token, f.info.orphaned])).toEqual([['a-000000', null], ['gone-111111', 'no-row']]);
  });
  it('a row whose directory is gone, or now holds another session, is an orphan', () => {
    const a = addGloveSession(home, 'a-000000');
    const b = addGloveSession(home, 'b-111111');
    rmSync(a.dir, { recursive: true });
    writeFileSync(join(b.dir, '.glove', 'id'), 'other-222222\n');
    const found = new NetSessionSource(() => home).discover().sessions;
    expect(found.map((f) => f.info.orphaned)).toEqual(['missing', 'stale']);
  });
  it('lists registered sessions without the observe grant, and never looks for their data', () => {
    registerRow(home, { id: 'dark-333333', dir: join(home, 'x'), harness: 'pi', grants: { observe: null, filter: null } });
    const found = new NetSessionSource(() => home).discover();
    expect(found.sessions).toEqual([]);
    expect(found.notObservable).toEqual([{ token: 'dark-333333', harness: 'pi', template: null }]);
  });
  it('a glove v2 registry (an array) is reported, never read', () => {
    writeFileSync(join(home, 'registry.json'), JSON.stringify([{ dir: '/w', harness: 'pi', env_id: 'pi-local' }]));
    const found = new NetSessionSource(() => home).discover();
    expect(found.registry.state).toBe('v2-home');
    expect(found.registry.detail).toMatch(/upgrade glove/);
  });
  it('another registry version is unsupported; broken JSON is unreadable and orphans nothing', () => {
    writeFileSync(join(home, 'registry.json'), JSON.stringify({ v: 3, sessions: [] }));
    expect(new NetSessionSource(() => home).discover().registry.state).toBe('unsupported');
    addGloveSession(home, 'a-000000', { registered: false });
    writeFileSync(join(home, 'registry.json'), '{');
    const found = new NetSessionSource(() => home).discover();
    expect(found.registry.state).toBe('unreadable');
    expect(found.sessions[0].info.orphaned).toBeNull();
  });
  it('finds nothing when disabled or absent', () => {
    expect(new NetSessionSource(() => null).discover().sessions).toEqual([]);
    expect(new NetSessionSource(() => join(home, 'missing')).discover()).toMatchObject({ sessions: [], registry: { state: 'absent' } });
  });
});

describe('registrable-domain grouping', () => {
  it.each([
    ['en.wikipedia.org', 'wikipedia.org'],
    ['a.b.co.uk', 'b.co.uk'],
    ['www.bbc.co.uk', 'bbc.co.uk'],
    ['WWW.Nature.COM', 'nature.com'],
    ['arxiv.org', 'arxiv.org'],
    ['foo.github.io', 'foo.github.io'],
    ['185.15.59.224', '185.15.59.224'],
    ['[2001:db8::1]', '[2001:db8::1]'],
    ['gluetun', 'gluetun'],
    ['llm.operator.lan', 'llm.operator.lan'],
    ['ads.tracker.example', 'ads.tracker.example'],
    ['co.uk', 'co.uk'],
    // Deep public suffixes the old built-in table could not know:
    ['a.b.pvt.k12.ma.us', 'b.pvt.k12.ma.us'],
    ['www.city.kawasaki.jp', 'city.kawasaki.jp'],
  ])('%s → %s', (host, want) => {
    expect(registrableDomain(host)).toBe(want);
  });
  it('null host → null, grouped by service endpoint', () => {
    expect(registrableDomain(null)).toBeNull();
    expect(groupKeyFor(null, 'proxy')).toBe('@proxy');
  });
  it('IP literal detection', () => {
    expect(isIpLiteral('169.254.169.254')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('256.1.1.1')).toBe(false);
    expect(isIpLiteral('example.com')).toBe(false);
  });
});
