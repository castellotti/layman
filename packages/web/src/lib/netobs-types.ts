/**
 * Network views of glove-sandboxed sessions: wire types.
 *
 * Hand-kept mirror of `packages/server/src/netobs/types.ts` (the "Type
 * duplication" rule in the root CLAUDE.md). The record types are glove's frozen
 * v1 contract (glove's `network-observability-layman-handoff.md` §2–§3); the rest
 * is Layman's derived view, computed on the server — the client never
 * re-derives a state. Keep the two files in sync.
 */

// ─── glove's records (handoff §2–§3) ─────────────────────────────────────────

export type FlowPhase = 'open' | 'update' | 'close';
export type FlowScope = 'tunnelled' | 'local' | 'direct';
export type FlowResolution = 'in-tunnel' | 'literal' | 'unavailable' | 'disabled';

export interface FlowDest {
  /** Null for a raw TCP flow with no SNI, or a malformed request. */
  host: string | null;
  port: number | null;
  /** Null unless resolution succeeded (in-tunnel, or the host was a literal). */
  ip: string | null;
  resolution: FlowResolution | string;
}

export interface FlowRoute {
  /** What the operator *declared* (`vpn`/`tor`/`direct`), or `tcp` for point-to-point. */
  kind: string;
  upstream: string | null;
}

/** `record: "full"` only. Credentials in `headers` arrive as `"[redacted]"`. */
export interface FlowRequest {
  method: string | null;
  url: string | null;
  headers?: Record<string, string>;
}

export interface FlowRecord {
  v: 1;
  type: 'flow';
  phase: FlowPhase;
  /** Stable across every phase, and across rotated files. */
  id: string;
  env: string;
  /** glove's session token — joins to `GloveSource`'s WatchRoot label. */
  session: string;
  t: string;
  t_open: string;
  t_close: string | null;
  service: string;
  tool: string | null;
  client: string | null;
  proto: string | null;
  dest: FlowDest;
  scope: FlowScope | string;
  route: FlowRoute | null;
  /** Cumulative, never a delta. */
  bytes: { up: number; down: number };
  verdict: 'allow' | 'block' | string;
  /** `builtin:…` (glove's guard), `r_…` (a rules.json rule), or null. */
  rule: string | null;
  close_reason: string | null;
  request: FlowRequest | null;
}

export interface ExitRecord {
  v: 1;
  type: 'exit';
  t: string;
  env: string;
  session: string;
  kind: string;
  ip: string | null;
  /** A country *name* as the source reported it ("Switzerland"), not an ISO code. */
  country: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
  /** Provenance, e.g. `via-proxy:am.i.mullvad.net`. Always shown: Layman did not determine this. */
  source: string | null;
  healthy: boolean;
}

export interface StatusRules {
  loaded_at: string | null;
  source_mtime: string | null;
  ok: boolean;
  error: string | null;
  active_count: number;
}

export interface StatusRecord {
  v: 1;
  gate: string | null;
  state: string;
  record: 'metadata' | 'full' | string;
  upstream: { kind: string | null; healthy: boolean | null } | null;
  resolver: { mode: string | null; healthy: boolean | null } | null;
  rules: StatusRules | null;
  /** Heartbeat, refreshed about every 5 s (additive in glove M1). */
  t: string | null;
  telemetry: {
    written: number;
    dropped: number;
    invalid: number;
    rotations: number;
  } | null;
}

export interface NetService {
  service: string;
  listen: string | null;
  observed: boolean;
  mode?: string;
  tool?: string | null;
  scope?: string | null;
  client?: string | null;
  upstream?: string | null;
  route?: FlowRoute | null;
  /** False for a listener the sandbox cannot reach (e.g. SearXNG's fan-out). */
  harness?: boolean;
}

export interface NetSessionFile {
  v: 1;
  type: 'session';
  env: string;
  session: string;
  harness: string | null;
  gate: string | null;
  record: string | null;
  resolve: string | null;
  resolver: string | null;
  /** `"none"` when exit identity is off: an empty exit.ndjson is then expected. */
  exit_identity: string | null;
  upstream_kind: string | null;
  rendered_at: string | null;
  services: NetService[];
}

export type RuleAction = 'allow' | 'block';

export interface RuleMatch {
  host?: string;
  ip?: string;
  port?: number | string;
  service?: string;
  tool?: string;
  scope?: string;
}

export interface Rule {
  id: string;
  action: RuleAction;
  match: RuleMatch;
  terminate?: boolean;
  note?: string;
}

export interface RulesFile {
  v: 1;
  env: string;
  session: string;
  updated_at?: string;
  updated_by?: string;
  default: RuleAction;
  rules: Rule[];
}

// ─── Derived (Layman's view) ─────────────────────────────────────────────────

/**
 * A flow's primary state: the one that decides its colour, label and toggle.
 * Orthogonal attributes (route scope, unresolved, no host, cleartext, fan-out)
 * are `FlowFlags`; session-wide states (rules rejected, stale gate, exit
 * verified…) are on `NetGateView`. Together they cover handoff §6.1 plus
 * "cleartext HTTP". `classify.ts` is the only place these are computed.
 */
export type NetState =
  /** Open, bytes moved within the last 3 s. */
  | 'active'
  /** Open, no byte change for more than 3 s (pooled keep-alive). */
  | 'pooled'
  /** Closed normally (`eof`, `reset`, or an unrecognised reason). */
  | 'finished'
  /** Refused by glove's built-in guard (`builtin:*`): never user-toggleable. */
  | 'guard'
  /** Blocked (or cut) by a rules.json rule. */
  | 'user_rule'
  /** Blocked by `default: "block"`: no rule matched. */
  | 'default_block'
  /** Upstream unreachable / timed out with a real destination: the path is broken. */
  | 'broken'
  /** Cut mid-transfer because the gate shut down. */
  | 'gate_shutdown'
  /** Allowed, no destination, closed on eof/timeout: noise, folded away. */
  | 'empty';

export interface FlowFlags {
  /** `scope` as glove classified it. */
  scope: FlowScope | 'unknown';
  /** Headed for the map but glove has no IP for it: the "Unknown location" bucket. */
  unresolved: boolean;
  /** `dest.host === null`: rendered as the service endpoint. */
  noHost: boolean;
  /** `proto: "http"` or port 80. */
  cleartext: boolean;
  /** SearXNG engine fan-out, not the agent's own traffic. */
  fanout: boolean;
}

/** One flow's latest state, as sent to the browser. */
export interface FlowView {
  id: string;
  phase: FlowPhase;
  tOpen: number;
  tClose: number | null;
  /** Time (ms) of the latest record for this id. */
  lastT: number;
  /** Time (ms) of the latest record whose bytes changed. */
  lastActivityAt: number;
  service: string;
  tool: string | null;
  client: string | null;
  proto: string | null;
  dest: FlowDest;
  scope: string;
  route: FlowRoute | null;
  bytes: { up: number; down: number };
  verdict: string;
  rule: string | null;
  closeReason: string | null;
  /** `record: "full"` only, passed through the PII string filter. */
  request: FlowRequest | null;
  state: NetState;
  flags: FlowFlags;
  /** Aggregate this flow counts toward; null for folded empty connections. */
  destKey: string | null;
  groupKey: string;
}

/** Bytes moved in one bucket. `t` is the bucket start in ms. */
export interface RateBucket {
  t: number;
  up: number;
  down: number;
}

/**
 * Per destination (host + port; a null host is keyed by its service endpoint).
 * Totals are running sums, so evicting closed flows from memory never changes them.
 */
export interface DestinationAggregate {
  key: string;
  host: string | null;
  port: number | null;
  /** Registrable domain (`wikipedia.org`), or the host itself for IPs and private names. */
  groupKey: string;
  /** For a null host: the service endpoint (`glove-pi-search-proxy:8888`) it arrived on. */
  endpoint: string | null;
  ips: string[];
  services: string[];
  tools: string[];
  clients: string[];
  scope: string;
  resolution: string;
  bytesUp: number;
  bytesDown: number;
  flows: number;
  openFlows: number;
  blocked: number;
  firstSeen: number;
  lastSeen: number;
  /** Summary state for the row: live if anything is live, else the latest flow's. */
  state: NetState;
  /** Latest block rule seen for this destination. */
  rule: string | null;
  flags: FlowFlags;
  /** Last 60 s at 1 s resolution, for the sparkline. Oldest first. */
  spark: RateBucket[];
}

export type GateFreshness = 'running' | 'stale' | 'stopped' | 'unknown';

/** Session-wide states from status.json, exit.ndjson and session.json. */
export interface NetGateView {
  freshness: GateFreshness;
  /** Raw `status.state`. */
  state: string | null;
  gateVersion: string | null;
  heartbeatAgeMs: number | null;
  record: string;
  route: {
    /** Declared route kind: `vpn`, `tor`, `direct`, `tcp`, or null when unknown. */
    kind: string | null;
    /** True only while the latest exit record is healthy. */
    verified: boolean;
    /** Exit identity is off (`exit_identity: "none"`): declared-only is expected, not an error. */
    exitIdentityOff: boolean;
    upstreamHealthy: boolean | null;
  };
  resolver: { mode: string | null; healthy: boolean | null; name: string | null };
  rules: StatusRules | null;
  telemetry: { written: number; dropped: number; invalid: number; rotations: number } | null;
  /** Declared services with `observed: false`: routes off the sandbox with no visibility. */
  unwatchedServices: string[];
}

/** rules.json as Layman last read it from the control directory. */
export interface RulesView {
  /** Where the file lives (or would live). */
  path: string;
  exists: boolean;
  /** Parsed file, or null when absent or unreadable. */
  file: RulesFile | null;
  /** Why the file on disk could not be read as a rules file. */
  readError: string | null;
  mtimeMs: number | null;
}

export interface NetCounters {
  records: number;
  /** Lines that did not parse, or carried `v` other than 1. */
  invalid: number;
  /** Records of an unknown `type`, skipped by design. */
  skipped: number;
  /** A rotated file that vanished before it was drained: records may be missing. */
  gaps: number;
}

export interface NetTotals {
  bytesUp: number;
  bytesDown: number;
  flows: number;
  openFlows: number;
  destinations: number;
  blocked: { guard: number; userRule: number; default: number };
  directFlows: number;
  broken: number;
}

export interface NetSessionSummary {
  token: string;
  env: string;
  /** Directory name under `envs/<env>/sessions/`. */
  name: string;
  harness: string | null;
  /** Gate running and its heartbeat fresh. */
  live: boolean;
  firstSeen: number | null;
  lastSeen: number | null;
  bytesUp: number;
  bytesDown: number;
  flows: number;
  directFlows: number;
  rulesOk: boolean | null;
}

export interface NetSnapshot {
  token: string;
  env: string;
  name: string;
  session: NetSessionFile | null;
  gate: NetGateView;
  exit: ExitRecord | null;
  /** Last 50 exit records, oldest first. */
  exits: ExitRecord[];
  rules: RulesView;
  destinations: DestinationAggregate[];
  /** Every open flow plus the most recent closed ones (up to 500 in a snapshot). */
  flows: FlowView[];
  /** Session-wide, 1 s resolution for the last hour. */
  buckets: RateBucket[];
  totals: NetTotals;
  counters: NetCounters;
  /** Allowed connections with no destination that closed empty (handoff §2). */
  emptyFolded: number;
  /** Backfill hit its byte budget: older rotated files were not read. */
  historyTruncated: boolean;
}

/** Changes since the previous delta. Every entry is the latest full value (replace, never add). */
export interface NetDelta {
  flows: FlowView[];
  destinations: DestinationAggregate[];
  /** Destinations left with no flows because a flow's `dest` was refined elsewhere. */
  removedDestinations: string[];
  /** Buckets touched since the last delta, with their current absolute values. */
  buckets: RateBucket[];
  totals: NetTotals;
  counters: NetCounters;
  emptyFolded: number;
}

// ─── WebSocket frames (mirror of NetServerMessage in netobs/index.ts) ────────

export type NetServerMessage =
  | { type: 'net:sessions'; sessions: NetSessionSummary[] }
  | { type: 'net:snapshot'; token: string; snapshot: NetSnapshot }
  | { type: 'net:delta'; token: string; delta: NetDelta }
  | { type: 'net:status'; token: string; status: NetGateView }
  | { type: 'net:exit'; token: string; exit: ExitRecord | null }
  | { type: 'net:rules'; token: string; rules: RulesView };
