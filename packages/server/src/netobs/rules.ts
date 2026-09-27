/**
 * rules.json, the one thing Layman writes into glove: a strict port of glove's
 * validator and first-match evaluation (`glove/netgate/policy.py`), and the
 * operations the UI performs on the file. Pure: the filesystem side is
 * `writer.ts`.
 *
 * The validator must accept exactly what the gate accepts. The gate rejects a
 * *whole* file for one unknown key and keeps its last good set, so Layman
 * refuses to write anything this rejects. `rules.crosscheck.test.ts` runs a
 * corpus of files through both this port and glove's own `glove net validate`
 * and requires the same verdict; change the two together.
 *
 * Deliberately no `node:net` (the no-network guard forbids importing it): IP
 * literals and CIDRs are parsed here, following Python's `ipaddress`.
 */
import type { Rule, RuleAction, RuleMatch, RulesFile, RulesOp } from './types.js';

export type { GroupKey, RulesOp } from './types.js';

export const MAX_BYTES = 1024 * 1024;
export const MAX_RULES = 10_000;
const TOP_KEYS = new Set(['v', 'env', 'session', 'updated_at', 'updated_by', 'default', 'rules']);
const RULE_KEYS = new Set(['id', 'action', 'match', 'terminate', 'note']);
const MATCH_KEYS = new Set(['host', 'ip', 'port', 'service', 'tool', 'scope']);
const SCOPES = new Set(['local', 'tunnelled', 'direct']);
const ID = /^r_[0-9A-Za-z_-]{1,64}$/;
const GLOB = /^[a-z0-9*?._-]{1,253}$/;
const LABEL = /^[A-Za-z0-9_.-]{1,64}$/;

export class RulesError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Python's `repr()` of a JSON value, for error messages that read like glove's. */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return `'${v}'`;
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  if (isObj(v)) return `{${Object.entries(v).map(([k, x]) => `'${k}': ${pyRepr(x)}`).join(', ')}}`;
  return String(v);
}
const sorted = (xs: Iterable<string>) => `[${[...xs].sort().map((x) => `'${x}'`).join(', ')}]`;

// ─── IP addresses (Python's ipaddress, the subset the gate uses) ─────────────

export interface IpAddr {
  version: 4 | 6;
  value: bigint;
}

export interface IpNet {
  version: 4 | 6;
  base: bigint;
  prefix: number;
}

function parseV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    // Decimal only, 1–3 digits, no leading zero (Python ≥ 3.9.5 rejects "01").
    if (!/^\d{1,3}$/.test(p) || (p.length > 1 && p[0] === '0')) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseV6(input: string): bigint | null {
  // Python accepts one non-empty scope id (`fe80::1%eth0`) and ignores it when matching.
  const scoped = input.split('%');
  if (scoped.length > 2 || (scoped.length === 2 && scoped[1] === '')) return null;
  const s = scoped[0];
  const parts = s.split(':');
  if (parts.length < 3 || parts.length > 9) return null;
  let tail: bigint[] = [];
  // An embedded IPv4 in the last group counts as two hextets.
  if (parts[parts.length - 1].includes('.')) {
    const v4 = parseV4(parts.pop()!);
    if (v4 === null) return null;
    tail = [(v4 >> 16n) & 0xffffn, v4 & 0xffffn];
    parts.push('__v4__');
  }
  const groups = parts;
  const skip = groups.map((g, i) => (g === '' && i > 0 && i < groups.length - 1 ? i : -1)).filter((i) => i >= 0);
  if (skip.length > 1) return null;
  let head: string[];
  let rest: string[];
  if (skip.length === 1) {
    head = groups.slice(0, skip[0]);
    rest = groups.slice(skip[0] + 1);
    if (head.length === 1 && head[0] === '') head = [];
    else if (head[0] === '') return null;
    if (rest.length === 1 && rest[0] === '') rest = [];
    else if (rest[rest.length - 1] === '') return null;
  } else {
    if (groups[0] === '' || groups[groups.length - 1] === '') return null;
    head = groups;
    rest = [];
  }
  const hex = (g: string): bigint | null => (/^[0-9A-Fa-f]{1,4}$/.test(g) ? BigInt(`0x${g}`) : null);
  const toVals = (gs: string[]): bigint[] | null => {
    const out: bigint[] = [];
    for (const g of gs) {
      if (g === '__v4__') out.push(...tail);
      else {
        const h = hex(g);
        if (h === null) return null;
        out.push(h);
      }
    }
    return out;
  };
  const a = toVals(head);
  const b = toVals(rest);
  if (!a || !b) return null;
  const missing = 8 - a.length - b.length;
  if (skip.length === 1 ? missing < 1 : missing !== 0) return null;
  const all = [...a, ...Array<bigint>(missing).fill(0n), ...b];
  return all.reduce((acc, h) => (acc << 16n) | h, 0n);
}

/** An IP literal, or null (Python's `ip_address`). */
export function parseIp(s: string): IpAddr | null {
  const v4 = parseV4(s);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseV6(s);
  return v6 === null ? null : { version: 6, value: v6 };
}

function maskPrefix(mask: bigint, bits: number): number | null {
  // A netmask (ones then zeros), else a hostmask (zeros then ones): Python tries them in that order.
  const all = (1n << BigInt(bits)) - 1n;
  for (let p = 0; p <= bits; p++) if (mask === ((all << BigInt(bits - p)) & all)) return p;
  for (let p = 0; p <= bits; p++) if (mask === (all >> BigInt(p))) return p;
  return null;
}

/** A network in `ip_network(strict=False)`'s sense: host bits are dropped, not refused. */
export function parseNetwork(s: string): IpNet | null {
  const slash = s.split('/');
  if (slash.length > 2) return null;
  const addr = parseIp(slash[0]);
  if (!addr) return null;
  const bits = addr.version === 4 ? 32 : 128;
  let prefix = bits;
  if (slash.length === 2) {
    const p = slash[1];
    if (/^\d+$/.test(p)) {
      prefix = Number(p);
      if (prefix > bits) return null;
    } else if (addr.version === 4) {
      const m = parseV4(p);
      const mp = m === null ? null : maskPrefix(m, 32);
      if (mp === null) return null;
      prefix = mp;
    } else return null;
  }
  const shift = BigInt(bits - prefix);
  return { version: addr.version, base: (addr.value >> shift) << shift, prefix };
}

export function inNetwork(ip: IpAddr, net: IpNet): boolean {
  if (ip.version !== net.version) return false;
  const shift = BigInt((net.version === 4 ? 32 : 128) - net.prefix);
  return ip.value >> shift === net.base >> shift;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface CompiledRule {
  id: string;
  action: RuleAction;
  host?: RegExp;
  net?: IpNet;
  port?: [number, number];
  service?: string;
  tool?: string;
  scope?: string;
  terminate: boolean;
}

export interface RuleSet {
  default: RuleAction;
  rules: CompiledRule[];
}

function str(v: unknown, what: string, pattern?: RegExp): string {
  if (typeof v !== 'string' || (pattern && !pattern.test(v))) throw new RulesError(`${what}: invalid value ${pyRepr(v)}`);
  return v;
}

function port(v: unknown): [number, number] {
  let lo: number;
  let hi: number;
  if (typeof v === 'number' && Number.isInteger(v)) {
    lo = hi = v;
  } else if (typeof v === 'string' && /^\d{1,5}-\d{1,5}$/.test(v)) {
    [lo, hi] = v.split('-').map(Number);
  } else {
    throw new RulesError(`match.port: must be an integer or 'lo-hi', got ${pyRepr(v)}`);
  }
  if (!(lo >= 1 && lo <= hi && hi <= 65535)) throw new RulesError(`match.port: out of range ${pyRepr(v)}`);
  return [lo, hi];
}

/** fnmatch.fnmatchcase for the glob charset the gate allows: `*` and `?` are the only specials. */
function globRegex(glob: string): RegExp {
  const body = [...glob].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.\\-]/g, '\\$&'))).join('');
  return new RegExp(`^${body}$`, 's');
}

function compileRule(i: number, raw: unknown): CompiledRule {
  const where = `rules[${i}]`;
  if (!isObj(raw)) throw new RulesError(`${where}: must be an object`);
  const extra = Object.keys(raw).filter((k) => !RULE_KEYS.has(k));
  if (extra.length) throw new RulesError(`${where}: unknown keys ${sorted(extra)} (allowed: ${sorted(RULE_KEYS)})`);
  const id = str(raw.id, `${where}.id`, ID);
  const action = raw.action;
  if (action !== 'allow' && action !== 'block') throw new RulesError(`${where}.action: must be allow|block, got ${pyRepr(action)}`);
  // Only an absent key means false: an explicit null is not a boolean (Python's `.get(k, False)`).
  const terminate = 'terminate' in raw ? raw.terminate : false;
  if (typeof terminate !== 'boolean') throw new RulesError(`${where}.terminate: must be a boolean`);
  const note = raw.note;
  if (note !== undefined && note !== null && (typeof note !== 'string' || [...note].length > 500)) {
    throw new RulesError(`${where}.note: must be a string of at most 500 characters`);
  }
  const m = raw.match;
  if (!isObj(m) || Object.keys(m).length === 0) {
    throw new RulesError(`${where}.match: must be a non-empty object (use \`default\` to match everything)`);
  }
  const extraM = Object.keys(m).filter((k) => !MATCH_KEYS.has(k));
  if (extraM.length) throw new RulesError(`${where}.match: unknown keys ${sorted(extraM)} (allowed: ${sorted(MATCH_KEYS)})`);
  const rule: CompiledRule = { id, action, terminate };
  if ('host' in m) {
    const h = m.host;
    rule.host = globRegex(str(typeof h === 'string' ? h.toLowerCase() : h, `${where}.match.host`, GLOB));
  }
  if ('ip' in m) {
    const s = str(m.ip, `${where}.match.ip`);
    const net = parseNetwork(s);
    if (!net) throw new RulesError(`${where}.match.ip: '${s}' does not appear to be an IPv4 or IPv6 network`);
    rule.net = net;
  }
  if ('port' in m) rule.port = port(m.port);
  for (const key of ['service', 'tool'] as const) {
    if (key in m) rule[key] = str(m[key], `${where}.match.${key}`, LABEL);
  }
  if ('scope' in m) {
    if (typeof m.scope !== 'string' || !SCOPES.has(m.scope)) {
      throw new RulesError(`${where}.match.scope: must be one of ${sorted(SCOPES)}`);
    }
    rule.scope = m.scope;
  }
  return rule;
}

/**
 * A RuleSet from parsed JSON, or a RulesError naming the first problem.
 * `env`/`session` (the token), when given, must equal the file's own.
 */
export function validateRules(data: unknown, opts: { env?: string; session?: string } = {}): RuleSet {
  if (!isObj(data)) throw new RulesError('top level must be an object');
  const extra = Object.keys(data).filter((k) => !TOP_KEYS.has(k));
  if (extra.length) throw new RulesError(`unknown top-level keys ${sorted(extra)} (allowed: ${sorted(TOP_KEYS)})`);
  // Python's `!= 1` also admits `true` (True == 1); JSON cannot tell 1 from 1.0.
  if (data.v !== 1 && data.v !== true) throw new RulesError(`v: must be 1, got ${pyRepr(data.v)}`);
  for (const [key, want] of [['env', opts.env], ['session', opts.session]] as const) {
    const val = str(data[key], key, LABEL);
    if (want !== undefined && val !== want) throw new RulesError(`${key}: file is for '${val}', this gate is '${want}'`);
  }
  for (const key of ['updated_at', 'updated_by']) {
    if (key in data && typeof data[key] !== 'string') throw new RulesError(`${key}: must be a string`);
  }
  const def = 'default' in data ? data.default : 'allow';
  if (def !== 'allow' && def !== 'block') throw new RulesError(`default: must be allow|block, got ${pyRepr(def)}`);
  const raw = 'rules' in data ? data.rules : [];
  if (!Array.isArray(raw)) throw new RulesError('rules: must be an array');
  if (raw.length > MAX_RULES) throw new RulesError(`rules: at most ${MAX_RULES} rules`);
  const rules = raw.map((r, i) => compileRule(i, r));
  if (new Set(rules.map((r) => r.id)).size !== rules.length) throw new RulesError('rules: duplicate rule id');
  return { default: def, rules };
}

/** The bytes of a file, as the gate reads them. */
export function parseRulesBytes(raw: Buffer, opts: { env?: string; session?: string } = {}): { set: RuleSet; data: Obj } {
  if (raw.length > MAX_BYTES) throw new RulesError(`file larger than ${MAX_BYTES} bytes`);
  let data: unknown;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw new RulesError(`not valid JSON: ${(e as Error).message}`);
  }
  return { set: validateRules(data, opts), data: data as Obj };
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

export interface FlowFacts {
  host: string | null;
  ip: string | null;
  port: number | null;
  service: string | null;
  tool: string | null;
  scope: string | null;
}

export interface Verdict {
  action: RuleAction;
  /** The matching rule, or null when the default applied. */
  rule: string | null;
  terminate: boolean;
}

function matches(r: CompiledRule, f: FlowFacts, ip: IpAddr | null): boolean {
  if (r.host && (!f.host || !r.host.test(f.host))) return false;
  if (r.net && (!ip || !inNetwork(ip, r.net))) return false;
  if (r.port && (f.port === null || f.port < r.port[0] || f.port > r.port[1])) return false;
  if (r.service !== undefined && f.service !== r.service) return false;
  if (r.tool !== undefined && f.tool !== r.tool) return false;
  if (r.scope !== undefined && f.scope !== r.scope) return false;
  return true;
}

/** First match wins; else the default (`RuleSet.evaluate`). */
export function evaluate(set: RuleSet, facts: FlowFacts): Verdict {
  const f = { ...facts, host: facts.host ? facts.host.toLowerCase() : null };
  const ip = f.ip ? parseIp(f.ip) : null;
  for (const r of set.rules) if (matches(r, f, ip)) return { action: r.action, rule: r.id, terminate: r.terminate };
  return { action: set.default, rule: null, terminate: false };
}

// ─── The built-in guard (glove/netgate/guard.py) ─────────────────────────────

/**
 * glove refuses, before any rule, a proxy destination that is not plainly public
 * (`forward.py` `_handle_proxy`): by the host's *shape*, then again by the IP the
 * in-tunnel resolver returned for it. So a user rule for such a host never
 * decides it, and a prediction that skipped the guard would name that rule.
 * Only `http-proxy` listeners run it; a `tcp` listener goes to a fixed endpoint.
 * `rules.crosscheck.test.ts` holds `guardRefuses` to glove's own `guard.check`.
 */
export const GUARD_RULE = 'builtin:ssrf-guard';

const LOCAL_SUFFIXES = [
  '.localhost', '.local', '.internal', '.lan', '.home', '.home.arpa',
  '.localdomain', '.intranet', '.corp', '.private',
];

/** `inet_aton`'s legacy IPv4 forms (`2130706433`, `0x7f.1`, `0177.0.0.1`): 1–4 parts, the last fills the rest. */
function parseLegacyV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length > 4) return null;
  const nums: bigint[] = [];
  for (const p of parts) {
    let n: bigint;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length > 2 ? BigInt(p) : 0n;
    else if (/^0[0-7]*$/.test(p)) n = p.length > 1 ? BigInt(`0o${p.slice(1)}`) : 0n;
    else if (/^[1-9]\d*$/.test(p)) n = BigInt(p);
    else return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  if (nums.some((n) => n > 255n)) return null;
  if (last >= 1n << BigInt(8 * (4 - nums.length))) return null;
  return nums.reduce((acc, n, i) => acc | (n << BigInt(8 * (3 - i))), 0n) | last;
}

/** `guard.ip_literal`: `host` as an address in any form a resolver accepts, IPv4-mapped IPv6 unwrapped. */
export function ipLiteral(host: string): IpAddr | null {
  let h = host.trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  let ip = parseIp(h);
  if (!ip && /^[0-9a-fx.]+$/.test(h.toLowerCase())) {
    const v = parseLegacyV4(h);
    if (v !== null) ip = { version: 4, value: v };
  }
  if (ip?.version === 6 && ip.value >> 32n === 0xffffn) return { version: 4, value: ip.value & 0xffffffffn };
  return ip;
}

const nets = (xs: string[]) => xs.map((x) => parseNetwork(x)!);
// Python's `ipaddress` tables (IANA special-purpose registries), as of the 3.14 that runs the cross-check.
const V4_PRIVATE = nets([
  '0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
  '192.0.0.170/31', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '240.0.0.0/4', '255.255.255.255/32',
]);
const V4_EXCEPTIONS = nets(['192.0.0.9/32', '192.0.0.10/32']);
const V4_SHARED = nets(['100.64.0.0/10']);
const V4_MULTICAST = nets(['224.0.0.0/4']);
const V6_PRIVATE = nets([
  '::1/128', '::/128', '::ffff:0:0/96', '64:ff9b:1::/48', '100::/64', '2001::/23', '2001:db8::/32',
  '2002::/16', '3fff::/20', 'fc00::/7', 'fe80::/10',
]);
const V6_EXCEPTIONS = nets(['2001:1::1/128', '2001:1::2/128', '2001:3::/32', '2001:4:112::/48', '2001:20::/28', '2001:30::/28']);
const V6_MULTICAST = nets(['ff00::/8']);

const inAny = (ip: IpAddr, ns: IpNet[]) => ns.some((n) => inNetwork(ip, n));

/** `ip.is_global and not ip.is_multicast`: what the guard lets through. */
export function isPublic(ip: IpAddr): boolean {
  const v4 = ip.version === 4;
  const priv = inAny(ip, v4 ? V4_PRIVATE : V6_PRIVATE) && !inAny(ip, v4 ? V4_EXCEPTIONS : V6_EXCEPTIONS);
  const global = !priv && !(v4 && inAny(ip, V4_SHARED));
  return global && !inAny(ip, v4 ? V4_MULTICAST : V6_MULTICAST);
}

/** `guard.check(host)[0] is not None`, for a normalized host (lowercase, no trailing dot) or an IP. */
export function guardRefuses(host: string): boolean {
  const ip = ipLiteral(host);
  if (ip) return !isPublic(ip);
  if (!host.includes('.')) return true;
  return host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s));
}

/** How a destination reached the gate, for `predict`. */
export interface GateFacts {
  /** It arrived on an `http-proxy` listener, the only kind the guard runs on. */
  proxy: boolean;
  /** `dest.resolution`: the guard re-checks the IP only when it came from the in-tunnel resolver. */
  resolution: string | null;
}

/**
 * What the gate would decide for these facts, in its order: the guard on the host,
 * the guard on the in-tunnel IP, then the rules (`evaluate`).
 */
export function predict(set: RuleSet, facts: FlowFacts, gate: GateFacts): Verdict {
  if (gate.proxy && facts.host) {
    const byIp = gate.resolution === 'in-tunnel' && facts.ip !== null && guardRefuses(facts.ip);
    if (guardRefuses(facts.host.toLowerCase()) || byIp) return { action: 'block', rule: GUARD_RULE, terminate: false };
  }
  return evaluate(set, facts);
}

// ─── Operations ──────────────────────────────────────────────────────────────

/** Rule ids of a "Cut all traffic" set: found and removed by `restoreAll`, never by hand. */
export const CUT_PREFIX = 'r_layman_cut_';
const CUT_NOTE = /restoring sets default "(allow|block)"/;

/** A new rule id: `r_` + 26 Crockford base32 characters, time-ordered like a ULID. */
export function newRuleId(now: number, random: (n: number) => Uint8Array): string {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = A[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += A[bytes[i] % 32];
  return `r_${time}${rand}`;
}

/**
 * The rule(s) an operation adds, without ids, in the order they go into the
 * file. Shared with the UI's JSON preview (mirrored in `lib/net-rules.ts`, and
 * a test holds the two together).
 */
export function opRules(op: RulesOp): Array<Omit<Rule, 'id'>> {
  const withNote = <T extends object>(r: T, note?: string) => (note ? { ...r, note } : r);
  switch (op.kind) {
    case 'blockHost':
      return [withNote({ action: 'block' as const, match: { host: op.host.toLowerCase() }, terminate: op.terminate }, op.note)];
    case 'blockDomain':
      // `*.example.com` does not match `example.com` (glove's record contract): the apex needs its own rule.
      return [
        withNote({ action: 'block' as const, match: { host: op.apex.toLowerCase() }, terminate: op.terminate }, op.note),
        withNote({ action: 'block' as const, match: { host: `*.${op.apex.toLowerCase()}` }, terminate: op.terminate }, op.note),
      ];
    case 'blockIp':
      return [withNote({ action: 'block' as const, match: { ip: op.ip }, terminate: op.terminate }, op.note)];
    case 'blockGroup':
      return [withNote({ action: 'block' as const, match: { [op.key]: op.value } as RuleMatch, terminate: op.terminate }, op.note)];
    case 'allowHost':
      return [withNote({ action: 'allow' as const, match: { host: op.host.toLowerCase() } }, op.note)];
    case 'allowDomain':
      return [
        withNote({ action: 'allow' as const, match: { host: op.apex.toLowerCase() } }, op.note),
        withNote({ action: 'allow' as const, match: { host: `*.${op.apex.toLowerCase()}` } }, op.note),
      ];
    case 'cutAll': {
      const cut = (scope: string) => ({ action: 'block' as const, match: { scope }, terminate: true });
      return [
        ...(op.keepLlm ? [{ action: 'allow' as const, match: { service: 'llm' } }] : []),
        cut('tunnelled'), cut('direct'), cut('local'),
      ];
    }
    default:
      return [];
  }
}

export interface ApplyContext {
  env: string;
  token: string;
  now: number;
  newId: () => string;
  /** SHA-256 of the file the op was applied to (null when absent), for `saveDraft`'s conflict check. */
  currentSha256: string | null;
}

/** An empty file for this session: what "no rules.json" means to the gate. */
export function emptyRules(env: string, token: string): RulesFile {
  return { v: 1, env, session: token, default: 'allow', rules: [] };
}

/**
 * The file after `op`, applied to a *fresh read* of it (never to Layman's idea
 * of what it wrote). New rules go at the **top**: an explicit block from a row
 * is the most specific intent, and the first match wins. Throws RulesError when
 * the op cannot apply (a stale draft, nothing to restore).
 */
export function applyOp(file: RulesFile, op: RulesOp, ctx: ApplyContext): RulesFile {
  const stamp = (f: RulesFile): RulesFile => ({ ...f, updated_at: new Date(ctx.now).toISOString(), updated_by: 'layman' });
  const withIds = (rules: Array<Omit<Rule, 'id'>>, ids?: string[]): Rule[] =>
    rules.map((r, i) => ({ id: ids?.[i] ?? ctx.newId(), ...r }));
  switch (op.kind) {
    case 'blockHost':
    case 'blockIp':
    case 'blockGroup':
    case 'allowHost':
      return stamp({ ...file, rules: [...withIds(opRules(op)), ...file.rules] });
    case 'blockDomain':
    case 'allowDomain': {
      // One stem, two suffixes: removing one rule of the pair can offer to remove both.
      const stem = ctx.newId();
      return stamp({ ...file, rules: [...withIds(opRules(op), [`${stem}-apex`, `${stem}-sub`]), ...file.rules] });
    }
    case 'removeRule': {
      const drop = new Set(op.ids);
      const rules = file.rules.filter((r) => !drop.has(r.id));
      if (rules.length === file.rules.length) throw new RulesError('none of those rules is in rules.json any more');
      return stamp({ ...file, rules });
    }
    case 'setDefault':
      return stamp({ ...file, default: op.default });
    case 'cutAll': {
      if (file.rules.some((r) => r.id.startsWith(CUT_PREFIX))) throw new RulesError('all traffic is already cut');
      const stem = ctx.newId().slice(2);
      const added = opRules(op).map((r, i) => ({
        id: `${CUT_PREFIX}${stem}_${i}`,
        ...r,
        note: `Cut all traffic (Layman); restoring sets default "${file.default}"`,
      }));
      return stamp({ ...file, default: 'block', rules: [...added, ...file.rules] });
    }
    case 'restoreAll': {
      const cut = file.rules.filter((r) => r.id.startsWith(CUT_PREFIX));
      if (!cut.length) throw new RulesError('traffic is not cut');
      const previous = cut.map((r) => CUT_NOTE.exec(r.note ?? '')?.[1]).find(Boolean) as RuleAction | undefined;
      return stamp({ ...file, default: previous ?? 'allow', rules: file.rules.filter((r) => !r.id.startsWith(CUT_PREFIX)) });
    }
    case 'saveDraft':
      if (op.baseSha256 !== ctx.currentSha256) {
        throw new RulesError('rules.json changed since you started editing; your draft was rebased, review it and save again');
      }
      return stamp({ ...file, default: op.default, rules: op.rules });
    case 'revert':
    case 'rewrite':
      // Handled by the writer: they write existing bytes, not a changed file.
      return file;
  }
}

/** The file as bytes, formatted like glove's CLI writes it. */
export function serializeRules(file: RulesFile): Buffer {
  const ordered: RulesFile = {
    v: 1,
    env: file.env,
    session: file.session,
    ...(file.updated_at !== undefined ? { updated_at: file.updated_at } : {}),
    ...(file.updated_by !== undefined ? { updated_by: file.updated_by } : {}),
    default: file.default,
    rules: file.rules,
  };
  return Buffer.from(JSON.stringify(ordered, null, 2) + '\n', 'utf8');
}

/** The file's rules as the RulesFile type, from data the validator already accepted. */
export function asRulesFile(data: Obj): RulesFile {
  const f: RulesFile = {
    v: 1,
    env: data.env as string,
    session: data.session as string,
    default: (data.default as RuleAction | undefined) ?? 'allow',
    rules: ((data.rules as Rule[] | undefined) ?? []).map((r) => ({ ...r })),
  };
  if (typeof data.updated_at === 'string') f.updated_at = data.updated_at;
  if (typeof data.updated_by === 'string') f.updated_by = data.updated_by;
  return f;
}
