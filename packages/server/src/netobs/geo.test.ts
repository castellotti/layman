import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GeoLocator } from './geo.js';
import { NetStore } from './store.js';
import { writeMmdb } from './testing/mmdb-writer.js';
import type { FlowRecord } from './types.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'netobs-geo-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const DB = [
  { cidr: '151.101.0.0/16', record: { city: 'San Francisco', countryCode: 'US', country: 'United States', lat: 37.77, lon: -122.42 } },
  { cidr: '185.15.59.224/32', record: { city: 'Amsterdam', countryCode: 'NL', country: 'Netherlands', lat: 52.37, lon: 4.9 } },
  { cidr: '203.0.113.0/24', record: { city: null, countryCode: 'AU', country: 'Australia', lat: -25, lon: 133 } },
];

function db(name = 'geo.mmdb', type = 'DBIP-City-Lite'): string {
  const p = join(dir, name);
  writeFileSync(p, writeMmdb(DB, type));
  return p;
}

describe('GeoLocator', () => {
  it('reads a MaxMind-format city database offline', () => {
    const geo = new GeoLocator(() => db());
    expect(geo.refresh()).toBe(true);
    expect(geo.status()).toMatchObject({ configured: true, loaded: true, databaseType: 'DBIP-City-Lite', buildDate: '2026-09-01', attribution: 'IP geolocation by DB-IP', error: null });
    expect(geo.lookup('151.101.3.42')).toEqual({ lat: 37.77, lon: -122.42, city: 'San Francisco', country: 'United States', countryCode: 'US' });
    expect(geo.lookup('185.15.59.224')?.city).toBe('Amsterdam');
    expect(geo.lookup('185.15.59.225')).toBeNull();
    expect(geo.lookup('203.0.113.9')).toMatchObject({ city: null, countryCode: 'AU' });
    expect(geo.lookup('not an ip')).toBeNull();
    expect(geo.lookup('2001:db8::1')).toBeNull(); // an IPv4-only database
  });

  it('credits a non-DB-IP database by its own name', () => {
    const geo = new GeoLocator(() => db('other.mmdb', 'Some-City'));
    geo.refresh();
    expect(geo.status().attribution).toBe('IP geolocation: Some-City');
  });

  it('reports none, a missing file and a file that is not a database, without throwing', () => {
    let path = '';
    const geo = new GeoLocator(() => path);
    geo.refresh();
    expect(geo.status()).toMatchObject({ configured: false, loaded: false, error: null });
    path = join(dir, 'nope.mmdb');
    expect(geo.refresh()).toBe(true);
    expect(geo.status()).toMatchObject({ configured: true, loaded: false, error: 'file not found' });
    writeFileSync(path, 'not a database');
    expect(geo.refresh()).toBe(true);
    expect(geo.status()).toMatchObject({ loaded: false, error: expect.stringContaining('not a readable') });
    expect(geo.lookup('151.101.3.42')).toBeNull();
  });

  it('reloads when the file changes, and not otherwise', () => {
    const path = db();
    const geo = new GeoLocator(() => path);
    geo.refresh();
    expect(geo.refresh()).toBe(false);
    writeFileSync(path, writeMmdb([{ cidr: '151.101.0.0/16', record: { city: 'Paris', countryCode: 'FR', country: 'France', lat: 48.85, lon: 2.35 } }]));
    expect(geo.refresh()).toBe(true);
    expect(geo.lookup('151.101.3.42')?.city).toBe('Paris');
  });
});

describe('what the store looks up', () => {
  const T = Date.parse('2026-09-25T12:00:00Z');
  const rec = (id: string, host: string, ip: string | null, resolution: string, scope: string): FlowRecord => ({
    v: 1, type: 'flow', phase: 'close', id, env: 'e', session: 'e', t: new Date(T).toISOString(), t_open: new Date(T).toISOString(),
    t_close: new Date(T).toISOString(), service: 'proxy', tool: 'web_fetch', client: 'harness', proto: 'http-connect',
    dest: { host, port: 443, ip, resolution }, scope, route: null, bytes: { up: 1, down: 1 }, verdict: 'allow', rule: null,
    close_reason: 'eof', request: null, run: null,
  });

  it('only in-tunnel or literal IPs, never local links', () => {
    const looked: string[] = [];
    const geo = new GeoLocator(() => db());
    geo.refresh();
    const store = new NetStore({ geolocate: (ip) => { looked.push(ip); return geo.lookup(ip); } });
    mkdirSync(join(dir, 'x'));
    store.ensure({ token: 'e', env: 'e', name: 'e', netDir: dir, controlDir: join(dir, 'c', 'e', 'e'), rulesPath: join(dir, 'c', 'e', 'e', 'rules.json') });
    store.ingestFlow('e', rec('f1', 'arxiv.org', '151.101.3.42', 'in-tunnel', 'tunnelled'), T);
    store.ingestFlow('e', rec('f2', '203.0.113.9', '203.0.113.9', 'literal', 'tunnelled'), T);
    store.ingestFlow('e', rec('f3', 'llm.lan', '151.101.9.9', 'in-tunnel', 'local'), T);
    store.ingestFlow('e', rec('f4', 'x.org', '151.101.8.8', 'disabled', 'tunnelled'), T);
    store.ingestFlow('e', rec('f5', 'y.org', null, 'unavailable', 'tunnelled'), T);
    const geoOf = (host: string) => store.snapshot('e')!.destinations.find((d) => d.host === host)!.geo;
    expect(geoOf('arxiv.org')?.city).toBe('San Francisco');
    expect(geoOf('203.0.113.9')?.countryCode).toBe('AU');
    expect(geoOf('llm.lan')).toBeNull();
    expect(geoOf('x.org')).toBeNull();
    expect(geoOf('y.org')).toBeNull();
    expect(new Set(looked)).toEqual(new Set(['151.101.3.42', '203.0.113.9']));
  });

  it('re-sends every destination when the database changes', () => {
    const store = new NetStore({ geolocate: () => null });
    store.ensure({ token: 'e', env: 'e', name: 'e', netDir: dir, controlDir: join(dir, 'c', 'e', 'e'), rulesPath: join(dir, 'c', 'e', 'e', 'rules.json') });
    store.ingestFlow('e', rec('f1', 'arxiv.org', '151.101.3.42', 'in-tunnel', 'tunnelled'), T);
    store.takeDelta('e');
    store.refreshGeo();
    expect(store.takeDelta('e')!.destinations.map((d) => d.host)).toEqual(['arxiv.org']);
  });
});
