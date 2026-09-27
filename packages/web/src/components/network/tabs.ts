/**
 * The four network tabs and each one's panels. Order here is the
 * default order; visibility defaults follow the plan (Network: Table, Map and
 * Rules on, Activity and Details off; Trace keeps only Trace and Details).
 */
import type { ViewMode } from '../../stores/sessionStore.js';
import type { PanelDef } from '../../lib/net-panels.js';

export type NetTab = Extract<ViewMode, 'network' | 'map' | 'topology' | 'trace'>;

export const NET_TABS: ReadonlyArray<{ key: NetTab; label: string; shortcut: string }> = [
  { key: 'network', label: 'Network', shortcut: 'N' },
  { key: 'map', label: 'Map', shortcut: 'M' },
  { key: 'topology', label: 'Topology', shortcut: 'O' },
  { key: 'trace', label: 'Trace', shortcut: 'T' },
];

export const TAB_PANELS: Record<NetTab, readonly PanelDef[]> = {
  network: [
    { id: 'table', title: 'Destinations', chip: 'Table', icon: 'table', defaultVisible: true, column: 'main' },
    { id: 'activity', title: 'Activity', chip: 'Activity', icon: 'activity', defaultVisible: false, column: 'main' },
    { id: 'map', title: 'Map', chip: 'Map', icon: 'map', defaultVisible: true, column: 'side' },
    { id: 'rules', title: 'Rules', chip: 'Rules', icon: 'rules', defaultVisible: true, column: 'side' },
    { id: 'details', title: 'Details', chip: 'Details', icon: 'details', defaultVisible: false, column: 'side' },
  ],
  map: [
    { id: 'world', title: 'Map', chip: 'Map', icon: 'map', defaultVisible: true, column: 'main' },
    { id: 'ribbon', title: 'Last 60 seconds', chip: 'Ribbon', icon: 'ribbon', defaultVisible: true, column: 'main' },
    { id: 'talking', title: 'Talking now', chip: 'Talking now', icon: 'activity', defaultVisible: true, column: 'side' },
    { id: 'detail', title: 'Details', chip: 'Details', icon: 'details', defaultVisible: true, column: 'side' },
    { id: 'unknown', title: 'Unknown location', chip: 'Unknown', icon: 'pin', defaultVisible: true, column: 'side' },
    { id: 'sandbox', title: 'This sandbox', chip: 'Sandbox', icon: 'rules', defaultVisible: true, column: 'side' },
    { id: 'legend', title: 'Legend', chip: 'Legend', icon: 'legend', defaultVisible: true, column: 'side' },
  ],
  topology: [
    { id: 'routes', title: 'Routes', chip: 'Topology', icon: 'topology', defaultVisible: true, column: 'main' },
    { id: 'path', title: 'Selected path', chip: 'Details', icon: 'details', defaultVisible: true, column: 'side' },
  ],
  trace: [
    { id: 'trace', title: 'Agent trace', chip: 'Trace', icon: 'trace', defaultVisible: true, column: 'main' },
    { id: 'details', title: 'Details', chip: 'Details', icon: 'details', defaultVisible: true, column: 'side' },
  ],
};
