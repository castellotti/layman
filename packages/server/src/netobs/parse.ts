/**
 * Tolerant readers for glove's network records (glove's record contract).
 *
 * The reader contract: accept `v: 1`, ignore unknown fields, skip an unknown
 * `type`, and count — never throw on — anything that does not parse. A glove-side
 * addition must never break a deployed Layman, so nothing here is strict about
 * what it does not need. (The *rules writer* is the opposite: strict, because the
 * gate rejects a whole file for one unknown key. That lives in `rules.ts`.)
 */
import type {
  ExitRecord,
  FlowDest,
  FlowPhase,
  FlowRecord,
  FlowRequest,
  FlowRoute,
  GateRecord,
  NetService,
  NetSessionFile,
  Rule,
  RulesFile,
  StatusRecord,
  StatusRules,
} from './types.js';

export type ParsedLine =
  | { kind: 'flow'; record: FlowRecord }
  | { kind: 'exit'; record: ExitRecord }
  | { kind: 'gate'; record: GateRecord }
  /** A well-formed v1 record of a type this Layman does not know. */
  | { kind: 'skipped' }
  /** Not JSON, not an object, `v` other than 1, or missing a required field. */
  | { kind: 'invalid' };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

const PHASES: ReadonlySet<string> = new Set(['open', 'update', 'close']);

function parseRoute(v: unknown): FlowRoute | null {
  if (!isObj(v)) return null;
  const kind = str(v.kind);
  return kind === null ? null : { kind, upstream: str(v.upstream) };
}

function parseRequest(v: unknown): FlowRequest | null {
  if (!isObj(v)) return null;
  const req: FlowRequest = { method: str(v.method), url: str(v.url) };
  if (isObj(v.headers)) {
    const headers: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.headers)) if (typeof val === 'string') headers[k] = val;
    req.headers = headers;
  }
  return req;
}

function parseDest(v: unknown): FlowDest {
  const d = isObj(v) ? v : {};
  return {
    host: str(d.host),
    port: num(d.port),
    ip: str(d.ip),
    resolution: str(d.resolution) ?? 'unavailable',
  };
}

function parseFlow(o: Obj): FlowRecord | null {
  const id = str(o.id);
  const phase = str(o.phase);
  const t = str(o.t);
  if (!id || !phase || !PHASES.has(phase) || !t || Number.isNaN(Date.parse(t))) return null;
  const bytes = isObj(o.bytes) ? o.bytes : {};
  return {
    v: 1,
    type: 'flow',
    phase: phase as FlowPhase,
    id,
    env: str(o.env) ?? '',
    session: str(o.session) ?? '',
    t,
    t_open: str(o.t_open) ?? t,
    t_close: str(o.t_close),
    service: str(o.service) ?? 'unknown',
    tool: str(o.tool),
    client: str(o.client),
    proto: str(o.proto),
    dest: parseDest(o.dest),
    scope: str(o.scope) ?? 'unknown',
    route: parseRoute(o.route),
    bytes: { up: Math.max(0, num(bytes.up) ?? 0), down: Math.max(0, num(bytes.down) ?? 0) },
    verdict: str(o.verdict) ?? 'allow',
    rule: str(o.rule),
    close_reason: str(o.close_reason),
    request: parseRequest(o.request),
    run: str(o.run),
  };
}

function parseGate(o: Obj): GateRecord | null {
  const run = str(o.run);
  const event = str(o.event);
  const t = str(o.t);
  if (!run || !event || !t || Number.isNaN(Date.parse(t))) return null;
  return {
    v: 1,
    type: 'gate',
    event,
    role: str(o.role) ?? 'forward',
    run,
    service: str(o.service),
    env: str(o.env) ?? '',
    session: str(o.session) ?? '',
    t,
    inferred: o.inferred === true,
  };
}

function parseExit(o: Obj): ExitRecord | null {
  const t = str(o.t);
  if (!t || Number.isNaN(Date.parse(t))) return null;
  return {
    v: 1,
    type: 'exit',
    t,
    env: str(o.env) ?? '',
    session: str(o.session) ?? '',
    kind: str(o.kind) ?? 'none',
    ip: str(o.ip),
    country: str(o.country),
    city: str(o.city),
    lat: num(o.lat),
    lon: num(o.lon),
    source: str(o.source),
    healthy: o.healthy === true,
  };
}

/** One NDJSON line. Blank lines are the caller's to skip. */
export function parseLine(line: string): ParsedLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isObj(raw) || raw.v !== 1) return { kind: 'invalid' };
  if (raw.type === 'flow') {
    const record = parseFlow(raw);
    return record ? { kind: 'flow', record } : { kind: 'invalid' };
  }
  if (raw.type === 'exit') {
    const record = parseExit(raw);
    return record ? { kind: 'exit', record } : { kind: 'invalid' };
  }
  if (raw.type === 'gate') {
    const record = parseGate(raw);
    return record ? { kind: 'gate', record } : { kind: 'invalid' };
  }
  return { kind: 'skipped' };
}

function parseStatusRules(v: unknown): StatusRules | null {
  if (!isObj(v)) return null;
  return {
    loaded_at: str(v.loaded_at),
    source_mtime: str(v.source_mtime),
    ok: v.ok !== false,
    error: str(v.error),
    active_count: num(v.active_count) ?? 0,
    sha256: str(v.sha256),
    last_rejected: isObj(v.last_rejected)
      ? {
          checked_at: str(v.last_rejected.checked_at),
          source_mtime: str(v.last_rejected.source_mtime),
          sha256: str(v.last_rejected.sha256),
          error: str(v.last_rejected.error),
        }
      : null,
  };
}

/** status.json. Null when it is not a v1 status object. */
export function parseStatus(raw: unknown): StatusRecord | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  const upstream = isObj(raw.upstream)
    ? { kind: str(raw.upstream.kind), healthy: bool(raw.upstream.healthy) }
    : null;
  const resolver = isObj(raw.resolver)
    ? { mode: str(raw.resolver.mode), healthy: bool(raw.resolver.healthy) }
    : null;
  const tel = isObj(raw.telemetry) ? raw.telemetry : null;
  return {
    v: 1,
    gate: str(raw.gate),
    state: str(raw.state) ?? 'unknown',
    record: str(raw.record) ?? 'metadata',
    upstream,
    resolver,
    rules: parseStatusRules(raw.rules),
    t: str(raw.t),
    telemetry: tel
      ? {
          written: num(tel.written) ?? 0,
          dropped: num(tel.dropped) ?? 0,
          invalid: num(tel.invalid) ?? 0,
          rotations: num(tel.rotations) ?? 0,
        }
      : null,
  };
}

function parseService(v: unknown): NetService | null {
  if (!isObj(v)) return null;
  const service = str(v.service);
  if (!service) return null;
  const s: NetService = {
    service,
    listen: str(v.listen),
    observed: v.observed !== false,
  };
  if (typeof v.mode === 'string') s.mode = v.mode;
  if ('tool' in v) s.tool = str(v.tool);
  if ('scope' in v) s.scope = str(v.scope);
  if ('client' in v) s.client = str(v.client);
  if ('upstream' in v) s.upstream = str(v.upstream);
  if ('route' in v) s.route = parseRoute(v.route);
  if (typeof v.harness === 'boolean') s.harness = v.harness;
  return s;
}

/** session.json. Null when it is not a v1 object. */
export function parseSessionFile(raw: unknown): NetSessionFile | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  const services = Array.isArray(raw.services)
    ? raw.services.map(parseService).filter((s): s is NetService => s !== null)
    : [];
  return {
    v: 1,
    type: 'session',
    env: str(raw.env) ?? '',
    session: str(raw.session) ?? '',
    harness: str(raw.harness),
    gate: str(raw.gate),
    record: str(raw.record),
    resolve: str(raw.resolve),
    resolver: str(raw.resolver),
    exit_identity: str(raw.exit_identity),
    upstream_kind: str(raw.upstream_kind),
    rendered_at: str(raw.rendered_at),
    services,
  };
}

/**
 * rules.json, read for *display*. Returns the file or the reason it cannot be
 * shown as one. This is deliberately not the gate's validator: the Rules panel
 * must still show a file the gate rejected, so the user can see what is wrong
 * with it. The strict port of `policy.py` is `rules.ts`.
 */
export function parseRulesForDisplay(raw: unknown): { file: RulesFile | null; error: string | null } {
  if (!isObj(raw)) return { file: null, error: 'top level must be an object' };
  if (raw.v !== 1) return { file: null, error: `v: must be 1, got ${JSON.stringify(raw.v)}` };
  if (!Array.isArray(raw.rules) && raw.rules !== undefined) return { file: null, error: 'rules: must be an array' };
  const rules: Rule[] = [];
  for (const r of (raw.rules as unknown[] | undefined) ?? []) {
    if (!isObj(r)) continue;
    const rule: Rule = {
      id: str(r.id) ?? '',
      action: r.action === 'allow' ? 'allow' : 'block',
      match: isObj(r.match) ? (r.match as Rule['match']) : {},
    };
    if (typeof r.terminate === 'boolean') rule.terminate = r.terminate;
    if (typeof r.note === 'string') rule.note = r.note;
    rules.push(rule);
  }
  const file: RulesFile = {
    v: 1,
    env: str(raw.env) ?? '',
    session: str(raw.session) ?? '',
    default: raw.default === 'block' ? 'block' : 'allow',
    rules,
  };
  if (typeof raw.updated_at === 'string') file.updated_at = raw.updated_at;
  if (typeof raw.updated_by === 'string') file.updated_by = raw.updated_by;
  return { file, error: null };
}
