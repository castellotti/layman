import { describe, expect, it } from 'vitest';
import { columnPanels, isPanelVisible, movePanel, resolvePanels, togglePanel, type PanelDef } from './net-panels.js';

const DEFS: PanelDef[] = [
  { id: 'table', title: 'Destinations', chip: 'Table', icon: 'table', defaultVisible: true, column: 'main' },
  { id: 'activity', title: 'Activity', chip: 'Activity', icon: 'activity', defaultVisible: false, column: 'main' },
  { id: 'map', title: 'Map', chip: 'Map', icon: 'map', defaultVisible: true, column: 'side' },
  { id: 'rules', title: 'Rules', chip: 'Rules', icon: 'rules', defaultVisible: true, column: 'side' },
];

describe('net panels', () => {
  it('defaults with nothing saved', () => {
    const s = resolvePanels(DEFS, null);
    expect(s.order).toEqual(['table', 'activity', 'map', 'rules']);
    expect(columnPanels(DEFS, s, 'main').map((p) => p.id)).toEqual(['table']);
    expect(columnPanels(DEFS, s, 'side').map((p) => p.id)).toEqual(['map', 'rules']);
  });

  it('survives garbage and drops unknown ids', () => {
    expect(resolvePanels(DEFS, 'nope').order).toHaveLength(4);
    const s = resolvePanels(DEFS, {
      order: ['rules', 'ghost', 42, 'map', 'rules', 'activity', 'table'],
      visible: { ghost: true, map: 'yes', activity: true },
    });
    expect(s.order).toEqual(['rules', 'map', 'activity', 'table']);
    expect(s.order).toHaveLength(4);
    expect(s.visible).toEqual({ activity: true });
  });

  it('places a panel added since the order was saved after its default predecessor', () => {
    const s = resolvePanels(DEFS, { order: ['rules', 'map', 'table'] });
    expect(s.order).toEqual(['rules', 'map', 'table', 'activity']);
  });

  it('toggles against the default and reorders by drag', () => {
    let s = resolvePanels(DEFS, null);
    s = togglePanel(DEFS, s, 'map');
    s = togglePanel(DEFS, s, 'activity');
    expect(isPanelVisible(DEFS, s, 'map')).toBe(false);
    expect(isPanelVisible(DEFS, s, 'activity')).toBe(true);
    s = movePanel(s, 'rules', 'map');
    expect(s.order).toEqual(['table', 'activity', 'rules', 'map']);
    expect(movePanel(s, 'rules', 'ghost')).toBe(s);
  });

  it('round-trips through JSON', () => {
    const s = togglePanel(DEFS, movePanel(resolvePanels(DEFS, null), 'rules', 'table'), 'table');
    expect(resolvePanels(DEFS, JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});
