import { describe, it, expect } from 'vitest';
import { headerTabs, currentTabIndex, neighbourTab } from './header-tabs.js';
import type { LaymanConfig } from './types.js';

const cfg = (styx: boolean) => ({ styx: { enabled: styx, godotDir: '' } }) as unknown as LaymanConfig;
const keys = (n: boolean, s: boolean) => headerTabs({ showNetwork: n, config: cfg(s) }).map((t) => t.key);

describe('headerTabs', () => {
  it('has the live and archive groups only by default', () => {
    expect(keys(false, false)).toEqual(['dashboard', 'stream', 'flowchart', 'activity', 'sessions', 'prompts']);
  });
  it('adds the network group after live', () => {
    expect(keys(true, false)).toEqual(['dashboard', 'stream', 'flowchart', 'activity', 'network', 'map', 'topology', 'trace', 'sessions', 'prompts']);
  });
  it('adds Matrix and Gibson with Styx, before the archive', () => {
    expect(keys(false, true)).toEqual(['dashboard', 'stream', 'flowchart', 'activity', 'matrix', 'matrix2d', 'matrix3d', 'gibson', 'gibson2d', 'gibson3d', 'sessions', 'prompts']);
  });
  it('tolerates a null config', () => {
    expect(headerTabs({ showNetwork: false, config: null })).toHaveLength(6);
  });
});

describe('currentTabIndex', () => {
  const tabs = headerTabs({ showNetwork: false, config: null });
  it('live: both panels → Dashboard left, Logs right', () => {
    expect(currentTabIndex(tabs, 'dashboard', { showDashboard: true, showLogs: true }, true)).toEqual({ left: 0, right: 1 });
  });
  it('live: only Logs', () => {
    expect(currentTabIndex(tabs, 'stream', { showDashboard: false, showLogs: true }, true)).toEqual({ left: 1, right: 1 });
  });
  it('live: only Dashboard', () => {
    expect(currentTabIndex(tabs, 'dashboard', { showDashboard: true, showLogs: false }, true)).toEqual({ left: 0, right: 0 });
  });
  it('outside live mode: the view mode', () => {
    expect(currentTabIndex(tabs, 'flowchart', { showDashboard: true, showLogs: false }, false)).toEqual({ left: 2, right: 2 });
  });
  it('an absent tab is -1', () => {
    expect(currentTabIndex(tabs, 'matrix', { showDashboard: true, showLogs: false }, false)).toEqual({ left: -1, right: -1 });
  });
});

describe('neighbourTab', () => {
  const tabs = headerTabs({ showNetwork: false, config: null });
  it('moves and stops at the ends', () => {
    expect(neighbourTab(tabs, { left: 2, right: 2 }, 1)?.key).toBe('activity');
    expect(neighbourTab(tabs, { left: 2, right: 2 }, -1)?.key).toBe('stream');
    expect(neighbourTab(tabs, { left: 0, right: 0 }, -1)).toBeNull();
    expect(neighbourTab(tabs, { left: 5, right: 5 }, 1)).toBeNull();
  });
  it('from an absent tab: ← last, → first', () => {
    expect(neighbourTab(tabs, { left: -1, right: -1 }, -1)?.key).toBe('prompts');
    expect(neighbourTab(tabs, { left: -1, right: -1 }, 1)?.key).toBe('dashboard');
  });
});
