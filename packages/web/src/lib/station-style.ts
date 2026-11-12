/**
 * How a station looks: its name, its colour and what it covers. Each colour is an existing theme
 * token that the print palette also redefines (the `--net-*` tokens are not), so a glyph themes and
 * prints dark on white; `station-style.test.ts` holds that. Pure; the glyphs are in `components/activity/StationGlyph.tsx`.
 */
import { eventStation, NO_SETUP, STATION_IDS, type StationId, type StationSetup } from './station.js';
import type { TimelineEvent } from './types.js';

export interface StationStyle {
  label: string;
  color: string;
  /** One line on what lands here, for a tooltip or a legend. */
  about: string;
}

export const STATION_STYLE: Record<StationId, StationStyle> = {
  you: { label: 'You', color: 'var(--info)', about: 'Your prompts, and what the agent asked or showed you' },
  model: { label: 'Model', color: 'var(--thinking)', about: 'Responses, reasoning and the agent’s own planning' },
  memory: { label: 'Memory', color: 'var(--accent)', about: 'Memory read or written, and instructions loaded into the context' },
  files: { label: 'Files', color: 'var(--code)', about: 'Reading, searching, moving and editing files' },
  shell: { label: 'Shell', color: 'var(--text-muted)', about: 'Commands that run programs' },
  network: { label: 'Network', color: 'var(--ok)', about: 'Fetches, searches, downloads, remote tools and commands that reach the network' },
  browser: { label: 'Browser', color: 'var(--accent-hot)', about: 'A browser driven by the agent' },
  agents: { label: 'Agents', color: 'var(--agent)', about: 'Subagents, and work started to run on later' },
  skills: { label: 'Skills', color: 'var(--severity-minor)', about: 'Skills and tools loaded on demand' },
  guard: { label: 'Guard', color: 'var(--warn)', about: 'Layman’s own decisions: approvals, denials, permission requests, drift checks' },
};

/**
 * A Logs row's station. The reasoning row Logs lifts out of a response (`agent_thinking`, a
 * display-only type) is the model's.
 */
export function rowStation(event: Pick<TimelineEvent, 'type' | 'data'>, setup: StationSetup = NO_SETUP): StationId | undefined {
  if (event.type === 'agent_thinking') return 'model';
  return eventStation(event.type, event.data as Record<string, unknown>, setup);
}

/** How many of the events fall at each station, in legend order, stations with none left out. */
export function stationCounts(events: readonly Pick<TimelineEvent, 'type' | 'data'>[], setup: StationSetup = NO_SETUP): { station: StationId; count: number }[] {
  const counts = new Map<StationId, number>();
  for (const e of events) {
    const s = rowStation(e, setup);
    if (s !== undefined) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return STATION_IDS.filter((s) => counts.has(s)).map((station) => ({ station, count: counts.get(station)! }));
}
