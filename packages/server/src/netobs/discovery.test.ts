import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NetSessionSource, controlPaths, gloveHomeFromSessionsDir, sessionToken, toHostPath } from './discovery.js';
import { groupKeyFor, isIpLiteral, registrableDomain } from './domain.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'netobs-disc-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const mkNet = (env: string, name: string) => mkdirSync(join(home, 'envs', env, 'sessions', name, 'net'), { recursive: true });

describe('session token and paths', () => {
  it('the default session (name === env) is the env id', () => {
    expect(sessionToken('pi-search', 'pi-search')).toBe('pi-search');
  });
  it('a named session is <env>-<name>', () => {
    expect(sessionToken('pi-search', 'review')).toBe('pi-search-review');
  });
  it('the glove home is the parent of the sessions dir', () => {
    expect(gloveHomeFromSessionsDir('/h/.glove/envs')).toBe('/h/.glove');
    expect(gloveHomeFromSessionsDir('/h/.glove/envs/')).toBe('/h/.glove');
  });
  it('the control path uses the directory name, not the token', () => {
    expect(controlPaths('/h/.glove', 'pi-search', 'review')).toEqual({
      controlDir: '/h/.glove/control/pi-search/review',
      rulesPath: '/h/.glove/control/pi-search/review/rules.json',
    });
  });
  it.each([['..', 'x'], ['x', '..'], ['a/b', 'x'], ['', 'x'], ['x', ''], ['.hidden', 'x'], ['x', 'a\\b']])(
    'refuses unsafe names %j / %j',
    (env, name) => {
      expect(controlPaths('/h/.glove', env, name)).toBeNull();
    },
  );
});

describe('toHostPath', () => {
  it('translates a container path back to the host home', () => {
    expect(toHostPath('/root/.glove/control/e/n/rules.json', '/Users/alice', '/root')).toBe('/Users/alice/.glove/control/e/n/rules.json');
  });
  it('is a no-op natively, and for paths outside the home', () => {
    expect(toHostPath('/home/u/.glove/x', undefined, '/home/u')).toBe('/home/u/.glove/x');
    expect(toHostPath('/tmp/x', '/Users/alice', '/root')).toBe('/tmp/x');
    expect(toHostPath('/rootless/x', '/Users/alice', '/root')).toBe('/rootless/x');
  });
});

describe('NetSessionSource', () => {
  it('finds default and named sessions with a net/ dir, and nothing else', () => {
    mkNet('pi-search', 'pi-search');
    mkNet('pi-search', 'review');
    mkdirSync(join(home, 'envs', 'vibe-x', 'sessions', 'vibe-x', 'home'), { recursive: true }); // no net/
    writeFileSync(join(home, 'envs', 'glove.yaml'), '');
    mkdirSync(join(home, 'envs', 'bad name', 'sessions', 'bad name', 'net'), { recursive: true });
    const found = new NetSessionSource(() => join(home, 'envs')).discover();
    expect(found.map((l) => l.token).sort()).toEqual(['pi-search', 'pi-search-review']);
    const review = found.find((l) => l.name === 'review')!;
    expect(review.netDir).toBe(join(home, 'envs', 'pi-search', 'sessions', 'review', 'net'));
    expect(review.rulesPath).toBe(join(home, 'control', 'pi-search', 'review', 'rules.json'));
  });
  it('finds nothing when disabled or absent', () => {
    expect(new NetSessionSource(() => null).discover()).toEqual([]);
    expect(new NetSessionSource(() => join(home, 'missing')).discover()).toEqual([]);
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
