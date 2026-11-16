import type { TimelineEvent } from './types.js';
import type { Token } from './tokens.js';
import { tokenColor } from './tokens.js';

/**
 * The bar colours subagents take, in turn. Theme tokens with no status meaning (never ok, warn or
 * error), and in this order so the first two, the likeliest pair to run at once, are the furthest
 * apart in every theme.
 */
export const SUBAGENT_TOKENS: readonly Token[] = ['agent', 'net-tunnel', 'info', 'thinking'];

export interface SubagentLane {
  /** 1-based, in the order the subagent first appears in the session. */
  n: number;
  token: Token;
  /** "Subagent 2 · Explore", for a tooltip. */
  label: string;
  /** "2 Explore" (or "sub 2" with no type, or "2 subagent" for general-purpose, whose type the tooltip names), for the chip on its rows. */
  chip: string;
}

/**
 * Tells a session's subagents apart. They all report into the parent's session (Claude Code gives a
 * subagent no session of its own), so two running at once interleave; each gets a number and a
 * colour by that number, so two never share a colour until there are more than
 * `SUBAGENT_TOKENS.length` of them.
 *
 * The number is the server's (`data.subagentN`, by first appearance in the whole session), never
 * counted here: a view holds a window of the session, and counting within it renumbered (and
 * recoloured) a subagent once earlier ones left the window, and numbered it differently in the
 * Dashboard and Logs, which hold different windows. Rows recorded before the server numbered
 * subagents have none; those take the lowest numbers no numbered subagent holds, in the order they
 * appear here.
 */
export function subagentLanes(
  events: readonly TimelineEvent[],
  /** The last result: an unchanged lane keeps its object, so a memoized row given it does not re-render. */
  prev?: Map<string, SubagentLane>,
): Map<string, SubagentLane> {
  // A subagent's type is the first one any of its events names: its opening event may not carry it.
  const types = new Map<string, string | undefined>();
  const numbered = new Map<string, number>();
  for (const event of events) {
    const id = event.data.subagentId;
    if (!id) continue;
    if (!types.get(id)) types.set(id, event.data.agentType);
    if (event.data.subagentN !== undefined && !numbered.has(id)) numbered.set(id, event.data.subagentN);
  }
  const taken = new Set(numbered.values());
  let next = 1;
  const lanes = new Map<string, SubagentLane>();
  for (const [id, type] of types) {
    let n = numbered.get(id);
    if (n === undefined) {
      while (taken.has(next)) next++;
      n = next;
      taken.add(n);
    }
    const lane: SubagentLane = {
      n,
      token: SUBAGENT_TOKENS[(n - 1) % SUBAGENT_TOKENS.length],
      label: `Subagent ${n}${type ? ` · ${type}` : ''}`,
      chip: !type ? `sub ${n}` : type === 'general-purpose' ? `${n} subagent` : `${n} ${type}`,
    };
    const old = prev?.get(id);
    lanes.set(id, old && old.n === lane.n && old.label === lane.label ? old : lane);
  }
  return lanes;
}

/**
 * How a subagent's row looks, shared by every view that draws one (Logs, Dashboard) so they cannot
 * drift: it rests on the agent shade, with a bar at its left edge in that subagent's own colour.
 */
export function laneRowStyle(lane?: SubagentLane): { rest: string; bar?: string } {
  return lane
    ? { rest: tokenColor('agent', '8%'), bar: `inset 3px 0 0 ${tokenColor(lane.token, '80%')}` }
    : { rest: 'transparent' };
}
