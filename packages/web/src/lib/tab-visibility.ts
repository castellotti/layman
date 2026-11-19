/**
 * Which Styx and network tabs the header lists. A hidden tab is only not listed: its view still
 * opens by link and says so (no redirect), so a shared address never breaks. Pure.
 */
import type { LaymanConfig } from './types.js';

export type StyxTabKey = 'matrix' | 'matrix2d' | 'matrix3d' | 'gibson' | 'gibson2d' | 'gibson3d';
export type NetTabKey = 'network' | 'map' | 'topology' | 'trace';

const GROUP: Record<StyxTabKey, 'matrix' | 'gibson'> = {
  matrix: 'matrix', matrix2d: 'matrix', matrix3d: 'matrix', gibson: 'gibson', gibson2d: 'gibson', gibson3d: 'gibson',
};

/** Styx is on, the tab's group is on, and the tab is. Absent fields (an older server) mean on. */
export function styxTabVisible(config: LaymanConfig | null | undefined, key: StyxTabKey): boolean {
  const s = config?.styx;
  if (s?.enabled !== true) return false;
  if (s[GROUP[key]] === false) return false;
  return s.tabs?.[key] !== false;
}

/** The tab's own switch only: whether glove and its network views are on is the caller's. */
export function netTabVisible(config: LaymanConfig | null | undefined, key: NetTabKey): boolean {
  return config?.glove?.network?.tabs?.[key] !== false;
}
