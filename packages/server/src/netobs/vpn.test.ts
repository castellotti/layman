import { describe, it, expect } from 'vitest';
import { normaliseVpnDomain, vpnEntryFor } from './vpn.js';

// The same cases as packages/web/src/lib/net-vpn.test.ts: the two copies must agree.
describe('vpnEntryFor', () => {
  const list = ['corp.example', '*.internal.test', '.dev.lan', 'git.other.com', '10.20.0.5'];
  it.each([
    ['corp.example', 'corp.example'],
    ['wiki.corp.example', 'corp.example'],
    ['A.B.Corp.Example.', 'corp.example'],
    ['x.internal.test', '*.internal.test'],
    ['internal.test', '*.internal.test'],
    ['box.dev.lan', '.dev.lan'],
    ['git.other.com', 'git.other.com'],
    ['10.20.0.5', '10.20.0.5'],
  ])('%s is covered by %s', (host, entry) => {
    expect(vpnEntryFor(host, list)).toBe(entry);
  });
  it.each([['notcorp.example'], ['corp.example.evil.com'], ['other.com'], ['www.other.com'], ['10.20.0.50']])('%s is not covered', (host) => {
    expect(vpnEntryFor(host, list)).toBeNull();
  });
  it('a null host and an empty list match nothing', () => {
    expect(vpnEntryFor(null, list)).toBeNull();
    expect(vpnEntryFor('corp.example', [])).toBeNull();
  });
  it('ignores entries that are not a host or suffix', () => {
    expect(normaliseVpnDomain('')).toBe('');
    expect(normaliseVpnDomain('  ')).toBe('');
    expect(normaliseVpnDomain('a b')).toBe('');
    expect(normaliseVpnDomain('a..b')).toBe('');
    expect(vpnEntryFor('x', ['*'])).toBeNull();
  });
  it('matches an IP only exactly, never as a suffix or a partial address', () => {
    expect(normaliseVpnDomain('10.0.0')).toBe('');
    expect(normaliseVpnDomain('0.1')).toBe('');
    expect(normaliseVpnDomain('10.20.0.5')).toBe('10.20.0.5');
    expect(vpnEntryFor('5.10.0.0', ['10.0.0', '0.0'])).toBeNull();
    expect(vpnEntryFor('1.10.20.0.5', ['10.20.0.5'])).toBeNull();
    expect(vpnEntryFor('fd00::1', ['::1'])).toBeNull();
    expect(vpnEntryFor('fd00::1', ['fd00::1'])).toBe('fd00::1');
  });
});
