/**
 * Network observability for glove-sandboxed sessions: the wire types.
 *
 * The *record* types (`FlowRecord`, `ExitRecord`, `StatusRecord`,
 * `NetSessionFile`, `RulesFile`) are glove's on-disk `net/` contract, frozen at
 * v1 (glove's README → Network observability). They are
 * read tolerantly (`parse.ts`): unknown fields are ignored, so a glove-side
 * addition never breaks a deployed Layman. Everything below the "Derived" line is
 * Layman's own view of that data.
 *
 * Mirrored by hand in `packages/web/src/lib/netobs-types.ts` (the "Type
 * duplication" rule in the root CLAUDE.md) — keep the two in sync.
 */

// ─── glove's records ─────────────────────────────────────────────────────────

export type FlowPhase = 'open' | 'update' | 'close';
/**
 * glove's scopes. `cloud` is glove v3's llm link to a provider on the internet.
 * `lan` is a routable host on the operator's network, never tunnelled: the llm
 * forwarder to a LAN inference server, or a `via: lan` relay such as glove's ssh
 * relay (`tool: ssh`). Neither is an alert, and no rule may name either
 * (glove's `RULE_SCOPES`): a rule matches their `tool` or `service` instead.
 */
export const FLOW_SCOPES = ['tunnelled', 'local', 'direct', 'lan', 'cloud'] as const;
export type FlowScope = (typeof FLOW_SCOPES)[number];
/** Off the tunnel by design (`lan`, `cloud`): never "untunnelled", never an alert. */
export const isOffTunnelScope = (scope: string): boolean => scope === 'lan' || scope === 'cloud';
/** glove's llm link: `cloud`, or `lan` when the tool is `llm` (a `lan` ssh host is not inference). */
export const isInferenceScope = (scope: string, tool: string | null | undefined): boolean =>
  scope === 'cloud' || (scope === 'lan' && tool === 'llm');
/** Never placed on the map nor geolocated: a local link, or a host on the LAN. */
export const neverMapped = (scope: string): boolean => scope === 'local' || scope === 'lan';
/**
 * glove's own refusal of a `via: lan` name that resolved to a public address (`--lan-only`):
 * a guard refusal, not a user's rule. `builtin:lan-only` is accepted too, in case glove renames it.
 */
export const isLanOnlyRule = (rule: string | null | undefined): boolean => rule === 'lan-only' || rule === 'builtin:lan-only';
/** Off the map: `neverMapped`, or a hop to a sidecar (`FlowFlags.hop`), whatever its scope says. */
export const offMap = (d: { scope: string; flags: { hop: boolean } }): boolean => neverMapped(d.scope) || d.flags.hop;
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
  /**
   * The forwarder process that emitted this record (`g_<ULID>`), additive in
   * glove's follow-up. Null from an older gate, whose flows can't be judged by
   * the gate-lifecycle rule.
   */
  run: string | null;
}

/**
 * A gate process starting or stopping (an additive field of
 * glove\'s record contract). `role: "forward"` is per service; `role: "collect"` is the collector
 * (`service: null`). A forwarder re-sends `start` as a heartbeat, so key on `run`.
 */
export interface GateRecord {
  v: 1;
  type: 'gate';
  event: 'start' | 'stop' | string;
  role: 'forward' | 'collect' | string;
  run: string;
  service: string | null;
  env: string;
  session: string;
  t: string;
  /** A stop the collector wrote for a forwarder silent for 30 s: it died. */
  inferred: boolean;
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
  /** SHA-256 (hex) of the file now enforced; null when there is no file (glove follow-up). */
  sha256: string | null;
  /** The most recent rejected read; kept after a later acceptance (`ok` is the current state). */
  last_rejected: {
    checked_at: string | null;
    source_mtime: string | null;
    /** Null when the file could not be read at all. */
    sha256: string | null;
    error: string | null;
  } | null;
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
  /**
   * The egress forwarders (`harness: false`) the sidecars behind this hop dial out
   * through: `llm` → `llm-upstream`, `webfetch-mcp` → `webfetch-egress`, `search-mcp` →
   * `searxng-egress`, …; `[]` when none. Static topology, transitive through sidecars,
   * with no per-flow link: a hop's flow is joined to the egress flows it causes by time.
   * glove lists a skipped gate (`observed: false`) too. Absent from gates before glove's
   * round 13, where `nextServices` matches the one pair it knows by its labels.
   */
  next?: string[];
}

/** The llm extension's second leg (`llm-upstream`): `harness: false`, tool `llm`, dialled by glove's llm-auth sidecar. */
export const isLlmUpstream = (s: NetService | undefined): boolean => !!s && s.harness === false && s.tool === 'llm';

/** The gates glove watches: one it lists with `observed: false` records nothing. */
const watched = (services: readonly NetService[]): NetService[] => services.filter((s) => s.observed !== false);

/**
 * The observed gates a service's traffic goes on through: glove's `next` when
 * session.json has it, else, for the harness's `llm` hop, the llm upstream leg
 * (with an injected key the hop ends at glove's llm-auth sidecar, which dials
 * the provider through `llm-upstream`). Empty for everything else.
 *
 * A gate glove lists but does not watch (`observed: false`) is left out: its
 * traffic is unrecorded, so the hop's own flows are the only record of it and
 * must not be set aside as a hop's.
 */
export function nextServices(svc: NetService | undefined, services: readonly NetService[]): NetService[] {
  if (!svc) return [];
  const gates = watched(services);
  if (Array.isArray(svc.next)) return gates.filter((s) => svc.next!.includes(s.service));
  if (svc.harness !== false && svc.tool === 'llm') return gates.filter(isLlmUpstream);
  return [];
}

/**
 * The service's flows are hops, their bytes counted at the next leg instead: it goes on
 * through a watched gate, and through no gate glove skips. With one of its `next` gates
 * unwatched, the hop's own flows are the only record of what went that way, so they count.
 */
export function isHopService(svc: NetService | undefined, services: readonly NetService[]): boolean {
  if (!nextServices(svc, services).length) return false;
  return !(svc!.next ?? []).some((name) => services.some((s) => s.service === name && s.observed === false));
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
 * verified…) are on `NetGateView`. Together they cover glove's state table plus
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
  /**
   * No `close`, but the forwarder that carried it has gone (a `stop` for its
   * `run`, or a newer run for the same service): cut by a gate that went away,
   * inferred (glove's record contract).
   */
  | 'gate_lost'
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
  /**
   * A hop to a sidecar whose traffic goes on through another gate (`nextServices`): the
   * `llm` hop to llm-auth. A local link whatever its scope says, never mapped, and its
   * bytes are counted once, at the leg that reaches the destination.
   */
  hop: boolean;
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
  /** Last 60 s at 1 s resolution, for the row's sparkline. Sparse, oldest first. */
  spark: RateBucket[];
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
  /**
   * Blocked flows by the rule that blocked them (`''`: the default), over the flows the files
   * still hold. `blocked` minus their sum is what only the kept history knows, by no rule.
   */
  blockedBy: Record<string, number>;
  flags: FlowFlags;
  /** Last 60 s at 1 s resolution, for the sparkline. Oldest first. */
  spark: RateBucket[];
  /**
   * What the rules say about this destination, before any new flow proves it:
   * first-match evaluation of its host, first IP, port, first service and tool,
   * and scope. `enforced` is the set the gate runs (null when Layman has not
   * seen it); `written` is rules.json on disk. They differ while a write is
   * waiting for the gate. The observed verdict (`state`) stays the authority.
   */
  policy: { enforced: PolicyVerdict | null; written: PolicyVerdict | null };
  /**
   * The IP the location is for: from the earliest flow (by `t_open`) whose IP glove resolved
   * inside the tunnel or that was a literal. It outlives later flows that have no IP, such as a
   * direct route's (`unavailable`), so it may differ from `ips[0]` and `resolution`. Null: none.
   */
  geoIp: string | null;
  /**
   * Where `geoIp` is, from the user's own offline database, unless the destination is
   * off the map (a local link or a hop). Null: "Unknown location".
   */
  geo: GeoPoint | null;
}

export interface GeoPoint {
  lat: number;
  lon: number;
  city: string | null;
  /** The database's country name. */
  country: string | null;
  countryCode: string | null;
}

/** The geolocation database's state (`GET /api/net/geo`). */
export interface GeoStatus {
  /** A path is set in Settings. */
  configured: boolean;
  path: string;
  /** The path as the user sees it on the host. */
  displayPath: string;
  loaded: boolean;
  databaseType: string | null;
  buildDate: string | null;
  error: string | null;
  /** The credit the map must show while this database is in use (DB-IP's licence requires it). */
  attribution: string | null;
}

export interface PolicyVerdict {
  action: RuleAction;
  /** The matching rule's id, or null when the default decided. */
  rule: string | null;
  /**
   * An allow on a `corporate` route: the rules let it through to glove's corporate
   * proxy, whose own allowlist (from the session file) then decides. Rules cannot widen it.
   */
  allowlist?: boolean;
  /**
   * glove's `--lan-only` refused this name at least once (it resolved to a public
   * address). That is decided at each connection, by a resolution Layman does not see,
   * so the verdict above is not a prediction that the next one goes through.
   */
  lanOnly?: boolean;
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
    /** Declared route kind: `vpn`, `tor`, `direct`, `corporate`, `tcp`, or null when unknown. */
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
  /** When each part last changed (`gateSince`), for the strip's tooltips; null where nothing says. */
  since: GateSince;
}

/**
 * A moment something became what it is. `exact` false means "at least since": Layman did not see
 * it change and no record says when it did (a restart, with the record that would tell rotated away).
 */
export interface SinceAt {
  t: number;
  exact: boolean;
}

export interface GateSince {
  /** The gate's state (`freshness`): running since its run started, stale since its last heartbeat. */
  gate: SinceAt | null;
  /** The route as shown: its kind and whether its exit is verified (not its upstream's health, which glove does not date). */
  route: SinceAt | null;
  /** The current exit IP. */
  exit: SinceAt | null;
  /** The resolver's mode and health. */
  resolver: SinceAt | null;
}

/**
 * An edit to rules.json, applied by the server to a fresh read of the file
 * (`rules.ts` `applyOp`). Sent by the client as `net:rules:apply`.
 */
export type GroupKey = 'tool' | 'service' | 'scope';

export type RulesOp =
  | { kind: 'blockHost'; host: string; terminate: boolean; note?: string }
  | { kind: 'blockDomain'; apex: string; terminate: boolean; note?: string }
  | { kind: 'blockIp'; ip: string; terminate: boolean; note?: string }
  | { kind: 'blockGroup'; key: GroupKey; value: string; terminate: boolean; note?: string }
  | { kind: 'allowHost'; host: string; note?: string }
  | { kind: 'allowDomain'; apex: string; note?: string }
  | { kind: 'removeRule'; ids: string[] }
  | { kind: 'setDefault'; default: RuleAction }
  | { kind: 'cutAll'; keepLlm: boolean }
  | { kind: 'restoreAll' }
  /** The Rules panel's draft: its rules and default replace the file's, if the file is still `baseSha256`. */
  | { kind: 'saveDraft'; baseSha256: string | null; default: RuleAction; rules: Rule[] }
  /** "Revert to enforced rules": write back the bytes the gate is enforcing. */
  | { kind: 'revert' }
  /** "Try again": write the file's current content back through the ownership contract. */
  | { kind: 'rewrite' };

/** Layman's last write of rules.json, and what the gate made of it. */
export interface RulesWriteView {
  opId: string;
  /** The `RulesOp` kind that produced it. */
  kind: string;
  /** SHA-256 of the bytes written; null for a removal. */
  sha256: string | null;
  at: number;
  /**
   * By glove's hash rule: `enforced` when status.json `rules.sha256` equals the
   * write's, `rejected` when `rules.last_rejected.sha256` does, `superseded`
   * when rules.json no longer holds it (another writer replaced it), else
   * `pending` — `unconfirmed` once that has lasted 10 s. `failed` never reached disk.
   */
  state: 'pending' | 'enforced' | 'rejected' | 'unconfirmed' | 'superseded' | 'failed';
  error: string | null;
}

/**
 * Whether Layman may write a session's rules.json. `not-granted`, `revoked` and
 * `orphaned` come from glove's grant and registry; the others from Layman's
 * setting and the control directory.
 */
export type ControlState = 'ok' | 'disabled' | 'not-granted' | 'revoked' | 'orphaned' | 'no-dir' | 'read-only';

/** The session's filter grant as Layman knows it: `revoked` = Layman saw it granted before, and it is not now. */
export type FilterAccess = 'granted' | 'not-granted' | 'revoked';

/** What glove says about a session (registry row and `session.json`), as the picker and header show it. */
export interface NetGloveInfo {
  template: string | null;
  /** Null for a history-only session: glove's files are gone, so nothing is known now. */
  filter: FilterAccess | null;
  /** The observe grant exports transcripts too. Null when unknown. */
  transcripts: boolean | null;
  /** Session deleted; export retained (glove's orphan rule). `glove gc` removes it. */
  orphaned: boolean;
}

/**
 * A registered session without the observe grant: no export, so no data, and Layman does not look for any.
 * Kept out of the session list (every consumer of which means "sessions with data"); only the picker shows it, disabled.
 */
export interface NetNotObservable {
  token: string;
  harness: string;
  template: string | null;
}

/**
 * The state of `~/.glove/registry.json`. `v2-home` is a glove v2 registry, which
 * Layman does not read (glove v3 only); the UI asks the user to upgrade glove.
 */
export interface GloveRegistryView {
  state: 'ok' | 'absent' | 'v2-home' | 'unsupported' | 'unreadable';
  detail: string;
}

/** rules.json as Layman last read it from the control directory, and whether Layman may change it. */
export interface RulesView {
  /** Where the file lives (or would live), as this process sees it. */
  path: string;
  /** The same path as the user sees it on the host (differs inside the container). */
  displayPath: string;
  exists: boolean;
  /** Parsed file (tolerantly, for display), or null when absent or unreadable. */
  file: RulesFile | null;
  /** Why the file on disk could not be read or shown as a rules file. */
  readError: string | null;
  mtimeMs: number | null;
  /** SHA-256 of the bytes on disk. */
  sha256: string | null;
  /** The gate's validator's verdict on the file on disk (null when valid, or absent). */
  invalid: string | null;
  /** The file on disk vs status.json, by glove's hash rule; `unknown` with no status. */
  enforcement: 'enforced' | 'rejected' | 'pending' | 'unknown';
  /** The set the gate enforces, when Layman has seen those bytes. Null when it cannot know. */
  enforced: RulesFile | null;
  /** Whether Layman may write this session's rules, and if not, why. */
  control: { state: ControlState; detail: string };
  write: RulesWriteView | null;
  /** The last time rules.json changed and it was not Layman's write. */
  externalChange: { at: number; sha256: string | null } | null;
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
  /** Flows moving or pooled now: open, and not cut by a gate that went away. */
  openFlows: number;
  /** Open flows whose gate went away (`gate_lost`). */
  gateLost: number;
  destinations: number;
  blocked: { guard: number; userRule: number; default: number };
  directFlows: number;
  broken: number;
}

export interface NetSessionSummary {
  /** glove's session id. */
  token: string;
  harness: string | null;
  glove: NetGloveInfo;
  /** Gate running and its heartbeat fresh. */
  live: boolean;
  firstSeen: number | null;
  lastSeen: number | null;
  bytesUp: number;
  bytesDown: number;
  flows: number;
  directFlows: number;
  rulesOk: boolean | null;
  /** glove's files for it are gone: what is shown is what Layman kept. */
  historyOnly: boolean;
}

/** A time window over a glove session's records (epoch ms). `to: null` runs until now and stays live. */
export interface NetRange {
  from: number;
  to: number | null;
}

/** What a ranged snapshot covers, and what it could not. */
export interface NetRangeInfo extends NetRange {
  /** The range's key (`rangeKey`): every frame for this range carries it. */
  key: string;
  /**
   * The earliest record time in the files read, or null when none were. Later than `from`
   * means the range starts before what glove still keeps (or `truncated` skipped it).
   */
  filesFrom: number | null;
  /**
   * The session's first record as far as Layman knows (kept history included), or null. A range
   * starting before it is not missing anything; `filesFrom` later than it is: glove deleted it.
   */
  sessionFrom: number | null;
  /** The scan reached its byte budget, so the range's oldest files were not read. */
  truncated: boolean;
  /**
   * The part of the range answered from Layman's hourly history (`net_hours`), because glove had
   * deleted those files or the scan's budget skipped them: whole hours, totals by destination, no
   * individual connections. `from` is its first hour with traffic, `to` where the files take over.
   * Null when the files answered all of it.
   */
  hourly: { from: number; to: number } | null;
  /** Bytes of glove's files read to build it. */
  scannedBytes: number;
}

export interface NetSnapshot {
  token: string;
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
  /** Allowed connections with no destination that closed empty (glove's record contract). */
  emptyFolded: number;
  /** Backfill hit its byte budget: older rotated files were not read. */
  historyTruncated: boolean;
  /** glove's files for it are gone: totals and destinations only, from what Layman kept. */
  historyOnly: boolean;
  /**
   * The time range it covers, or null for All records. A ranged snapshot is built from
   * glove's files for that window (`netobs/range.ts`), never filtered from this one.
   */
  range: NetRangeInfo | null;
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

// ─── Trace ───────────────────────────────────────────────────────

/**
 * How well a tool call's times are known. `exact`: the transcript's own times,
 * or a hook that fired as the call started and ended. `approximate`: a passive
 * watcher read the call after the fact and nothing kept the transcript's times,
 * so only "it had finished by `start`" is known; such calls join by host alone.
 */
export type TraceTiming = 'exact' | 'approximate';
/** `relay`: a shell command glove relays to a sidecar (`gh`, `git push`, `ssh <host>`), which makes the traffic. */
/** One of glove's relay sidecars and, for ssh, the host the command names. */
export type Relay = { via: 'github' | 'ssh'; host: string | null };

export type TraceCallKind = 'fetch' | 'search' | 'relay' | 'other';

/** A file `web_download` saved, from the call's own result (`saved:`, `bytes:`, `sha256:`). */
export interface TraceDownload {
  /** Where the harness sees it: `/work/downloads/<name>`. */
  path: string;
  bytes: number | null;
  sha256: string | null;
  contentType: string | null;
  /** After redirects; the call's `url` is where it started. */
  finalUrl: string | null;
}

/** A saved download and the call that reported it (`GET /api/net/sessions/:token/downloads`). */
export interface SessionDownload extends TraceDownload {
  eventId: string;
  sessionId: string;
  toolName: string;
  /** The URL the call asked for; null for a status call, which names only a job. */
  url: string | null;
  /** When the call that reported it started. */
  at: number;
}

export interface TraceCall {
  /** The Layman event id of the tool call. */
  eventId: string;
  sessionId: string;
  toolName: string;
  kind: TraceCallKind;
  /** The URL, the search query, or a short summary of the call. */
  label: string;
  /**
   * Hosts a fetch (or a relay call) names, lower-case, with the port when the URL spelled one
   * out; a relayed ssh command's host too, which an unrelayed ssh reaches through the proxy.
   */
  targets: Array<{ host: string; port: number | null }>;
  /**
   * The PII filter redacted part of a URL this call names (a literal IP, say),
   * so its flows cannot be joined to it: they stay unattributed.
   */
  redacted: boolean;
  /** When the call started; for `approximate`, when Layman read it (it had ended by then). */
  start: number;
  /** When it ended; null while it runs. */
  end: number | null;
  timing: TraceTiming;
  failed: boolean;
  /**
   * For a `relay` call, the sidecar that makes its traffic: glove's github relay
   * (client `github`), or its ssh relay and the host the command names (gate `ssh-<host>`).
   */
  relay: Relay | null;
  /** Files a `web_download` / `web_download_status` call reported saved. */
  downloads: TraceDownload[];
  /**
   * Tools a Pi codemode script calls (`tools.web_fetch`, …), read from its `code`: the
   * nested calls never reach the transcript as calls of their own. Empty for any other call.
   */
  nested: string[];
}

export type TraceItem =
  | {
    kind: 'call'; call: TraceCall; flowIds: string[]; fanoutIds: string[];
    /**
     * Matching connections already open when the call started, opened by an earlier call or turn.
     * A kept-alive connection carries later calls without a new flow; metadata cannot say how
     * much of it was this call's, so these are named, never claimed.
     */
    openIds: string[];
  }
  | {
    kind: 'llm';
    /** The flow that reached the model: the upstream leg when there is one. */
    flowId: string;
    /** The harness's hops to llm-auth folded into this request (`FlowFlags.hop`). */
    hopIds: string[];
  };

export interface TraceTurn {
  sessionId: string;
  promptEventId: string;
  responseEventId: string | null;
  /** 0-based position of the turn in its Layman session. */
  index: number;
  startedAt: number;
  /**
   * When the turn's last event finished (its transcript time when the harness kept one), or
   * null while it is still running: the end of "Network for this turn" (`turnRange`).
   */
  endedAt: number | null;
  /** The times are the transcript's; else the events' read time, and a range from them is approximate. */
  exact: boolean;
  promptText: string;
  toolCallCount: number;
}

export interface TraceCounts {
  calls: number;
  flows: number;
  /** Refused by glove's guard. */
  refused: number;
  /** Blocked by a rule or the default. */
  blocked: number;
  bytesUp: number;
  bytesDown: number;
}

/** One turn's tool calls joined to the flows they made (`GET /api/net/sessions/:token/trace`). */
export interface TraceNav {
  /** The shown turn's position, from 0; -1 when none is shown. */
  index: number;
  count: number;
  /** Prompt event ids of the turns either side, for the arrows. */
  prev: string | null;
  next: string | null;
  /**
   * With a time range, the turns counted are those that began in it; true when the shown turn
   * (asked for by id) began outside it, so `index` is -1 and the arrows lead back into it.
   */
  outside?: boolean;
}

export interface TraceView {
  token: string;
  /** Layman sessions whose `sessionName` is this glove session's token. */
  sessionIds: string[];
  /** Where the shown turn sits among their turns within the glove session's span, oldest first. */
  nav: TraceNav;
  /** The turn shown; null when there is none. */
  turn: TraceTurn | null;
  /** Flows opened in [from, to] belong to the turn. */
  window: { from: number; to: number } | null;
  items: TraceItem[];
  /** Flow ids in the turn's window that no call claimed. Never guessed. */
  unattributed: string[];
  /** Every flow the items and `unattributed` name. */
  flows: FlowView[];
  counts: TraceCounts;
}

// ─── Segments: ready-made time ranges (`segments.ts`) ─────────────────────────

export interface RunSegment {
  run: string;
  from: number;
  /** Null while it runs. */
  to: number | null;
  /** How it ended: glove down, the collector's inferred stop, the next run starting, or not yet. */
  end: 'stopped' | 'died' | 'replaced' | null;
  bytesUp: number;
  bytesDown: number;
  flows: number;
}

export interface BurstSegment {
  from: number;
  to: number;
  /** The run it is in, or null for records from before any collector run (an older gate). */
  run: string | null;
  bytesUp: number;
  bytesDown: number;
  flows: number;
}

export interface AgentSegment {
  sessionId: string;
  from: number;
  to: number;
  turns: number;
  /** Times from the transcript; false when only read times were kept, which can lag. */
  exact: boolean;
}

/** One hour of the session's activity, its hops' bytes left out (counted at the next leg). */
export interface HourActivity {
  hour: number;
  bytesUp: number;
  bytesDown: number;
  flows: number;
  blocked: number;
  first: number;
  last: number;
  /** The agent called its model in this hour. */
  inference: boolean;
}

export interface NetSegments {
  token: string;
  gapMs: number;
  /** What bursts were found from: model calls, or (with none observed) all traffic. */
  burstBasis: 'inference' | 'traffic';
  runs: RunSegment[];
  bursts: BurstSegment[];
  agentSessions: AgentSegment[];
  hours: HourActivity[];
}
