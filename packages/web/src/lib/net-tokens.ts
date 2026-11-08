/**
 * Topology's token tiles (Selected path → Details): which destination gets them and how each
 * kind is drawn. The tokens are the glove session's own, read from its pi transcripts by the
 * server (`pi/usage.ts`), and follow the same time range as SENT/RECEIVED.
 */
import type { DestinationAggregate, NetOptionalKind, NetTokens } from './netobs-types.js';
import type { NetIconName } from '../components/network/netui.js';
import { formatTokens, thinkingShare } from './format.js';

/** The session's LLM path: the `llm` service, its `llm-upstream` leg, or the hop to llm-auth. */
export function isLlmDestination(d: Pick<DestinationAggregate, 'tools'>): boolean {
  return d.tools.includes('llm');
}

export interface TokenTileSpec {
  label: string;
  value: string;
  /** Exact count, for the tip. */
  exact: string;
  sub?: string;
  icon: NetIconName;
  colour: string;
}

/**
 * The tiles, in order: input, output, cache read, cache write, thinking (with its share of
 * output). An optional kind the session never reported (`reported`, from the server) is left
 * out: its 0 means the provider does not send it, not that there were none. No `reported`: all five.
 */
export function tokenTiles(t: NetTokens, reported?: readonly NetOptionalKind[]): TokenTileSpec[] {
  const shown = (k: NetOptionalKind) => !reported || reported.includes(k);
  const tile = (label: string, n: number, icon: NetIconName, colour: string, sub?: string): TokenTileSpec =>
    ({ label, value: formatTokens(n), exact: `${n.toLocaleString('en-US')} tokens`, sub, icon, colour });
  const share = thinkingShare(t.reasoning, t.output);
  return [
    tile('INPUT', t.input, 'up', 'var(--net-up)'),
    tile('OUTPUT', t.output, 'down', 'var(--net-down)'),
    shown('cacheRead') && tile('CACHE READ', t.cacheRead, 'tokens', 'var(--net-tunnel)'),
    shown('cacheWrite') && tile('CACHE WRITE', t.cacheWrite, 'tokens', 'var(--text-muted)'),
    shown('reasoning') && tile('THINKING', t.reasoning, 'thinking', 'var(--info)', share === null ? undefined : `${share}% of output`),
  ].filter((x): x is TokenTileSpec => !!x);
}
