import { describe, it, expect } from 'vitest';
import { normaliseVpnDomain, vpnEntryFor, vpnEntriesFor, withVpnEntry, isUntunnelled, untunnelledFlows, vpnParentDomain } from './net-vpn.js';

// The same cases as packages/server/src/netobs/vpn.test.ts: the two copies must agree.
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

describe('list edits', () => {
  it('adds an entry once, as matched', () => {
    expect(withVpnEntry(['corp.example'], '*.Corp.Example')).toEqual(['corp.example']);
    expect(withVpnEntry([], '*.corp.example')).toEqual(['corp.example']);
    expect(withVpnEntry([], 'not valid')).toEqual([]);
  });
  it('finds every entry covering a host, so Unmark leaves it uncovered', () => {
    expect(vpnEntriesFor('a.corp.example', ['corp.example', 'a.corp.example', 'other.com'])).toEqual(['corp.example', 'a.corp.example']);
  });
});

describe('untunnelled', () => {
  it('is direct and not a known VPN route', () => {
    expect(isUntunnelled('direct', {})).toBe(true);
    expect(isUntunnelled('direct', { vpn: 'corporate' })).toBe(false);
    expect(isUntunnelled('direct', { vpn: 'listed' })).toBe(false);
    expect(isUntunnelled('tunnelled', {})).toBe(false);
  });
  it('counts glove\'s direct flows less the VPN ones, never below zero', () => {
    expect(untunnelledFlows({ directFlows: 5 })).toBe(5);
    expect(untunnelledFlows({ directFlows: 5, vpnFlows: 3 })).toBe(2);
    expect(untunnelledFlows({ directFlows: 1, vpnFlows: 3 })).toBe(0);
  });
});

describe('vpnParentDomain', () => {
  it('is the parent domain, never a public registrable domain or an IP', () => {
    expect(vpnParentDomain('jira.corp.example.com')).toBe('corp.example.com');
    expect(vpnParentDomain('git.corp.internal')).toBe('corp.internal');
    expect(vpnParentDomain('example.com')).toBeNull();
    expect(vpnParentDomain('10.20.0.5')).toBeNull();
    expect(vpnParentDomain(null)).toBeNull();
  });
});
