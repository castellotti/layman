import type { TimelineEvent } from './types.js';
import type { Token } from './tokens.js';

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
  /** "2 Explore" (or "sub 2" with no type), for the chip on its rows. */
  chip: string;
}

/**
 * Tells a session's subagents apart. They all report into the parent's session (Claude Code gives a
 * subagent no session of its own), so two running at once interleave; each gets a number, in the
 * order it first appears, and a colour by that number. Numbering by appearance rather than hashing
 * the id means two subagents never share a colour until there are more than
 * `SUBAGENT_TOKENS.length` of them, and a subagent keeps its number as events arrive, because new
 * events only ever add subagents after the ones already seen.
 */
export function subagentLanes(
  events: readonly TimelineEvent[],
  /** The last result: an unchanged lane keeps its object, so a memoized row given it does not re-render. */
  prev?: Map<string, SubagentLane>,
): Map<string, SubagentLane> {
  const lanes = new Map<string, SubagentLane>();
  for (const event of events) {
    const id = event.data.subagentId;
    if (!id || lanes.has(id)) continue;
    const n = lanes.size + 1;
    const type = event.data.agentType;
    const lane: SubagentLane = {
      n,
      token: SUBAGENT_TOKENS[(n - 1) % SUBAGENT_TOKENS.length],
      label: `Subagent ${n}${type ? ` · ${type}` : ''}`,
      chip: type ? `${n} ${type}` : `sub ${n}`,
    };
    const old = prev?.get(id);
    lanes.set(id, old && old.n === lane.n && old.label === lane.label ? old : lane);
  }
  return lanes;
}
