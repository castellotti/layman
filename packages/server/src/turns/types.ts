/**
 * A "turn" is one user prompt plus everything the agent did in response to it,
 * up to (but not including) the next user prompt.
 *
 * This mirrors the ownership rule already implemented client-side in
 * packages/web/src/lib/event-pairing.ts (`pairFor`).  Keep the two in sync —
 * see CLAUDE.md "Type duplication".
 */

/** Minimal addressable reference to a turn. */
export interface TurnRef {
  sessionId: string;
  promptEventId: string;
  /** null when the turn produced no agent_response (still in flight, or aborted). */
  responseEventId: string | null;
}

export interface Turn extends TurnRef {
  /** 0-based position of this turn within its session. */
  index: number;
  promptText: string;
  /** Reasoning/thinking blocks already stripped. */
  responseText: string;
  thinkingText: string | null;
  startedAt: number;
  /** Timestamp of the last event owned by the turn; null when the turn is empty. */
  endedAt: number | null;
  /** Every event owned by the turn, in order, including the prompt itself. */
  eventIds: string[];
  toolCallCount: number;
  /** Count of owned events per risk level, e.g. `{ low: 3, high: 1 }`. */
  riskLevels: Record<string, number>;
  agentType: string;
}
