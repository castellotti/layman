/**
 * Joins a turn's tool calls (from the harness transcript Layman records) to the
 * flows glove's gate saw. This is what Layman can do and glove
 * cannot: glove never learns the URL behind an HTTPS CONNECT, but the
 * transcript has the exact `web_fetch` call.
 *
 * Pure: `trace.ts` gathers the inputs. The rules, in order:
 *   1. A call that names URLs claims a flow to the URL's host (and port, when
 *      the URL spells one out) that opened between its start − 1 s and its end
 *      + 2 s. Several calls could claim one flow: the nearest start wins.
 *   2. A search call claims the `search` service's flows and SearXNG's fan-out
 *      opened in its window, nearest start again. A fetch tool's call (never a
 *      shell command that names a URL) likewise claims the hop to a fetcher sidecar (Vibe's `webfetch-mcp`), whose destination
 *      is the sidecar rather than the URL's host; the sidecar's own egress
 *      (client `webfetch`) names the host and joins by rule 1. Downloads are kept
 *      apart: only `web_download` / `web_download_status` claim the `web_download`
 *      hop and egress, and only they. A shell command glove relays (`gh`, `git push`,
 *      `ssh build …`, read from its leading words: `shell.ts`) claims its relay's
 *      flows: client `github`, or the gate `ssh-<host>` it names.
 *   3. Model requests become LLM rows between the calls: the flows that reached
 *      the model. With glove's llm-auth, a request is two flows, the harness's
 *      hop to llm-auth (`FlowFlags.hop`) and llm-upstream's leg to the provider;
 *      each hop is folded into the nearest leg, one to one, so a request is one row.
 *   4. Anything else in the turn is Unattributed. Never guess.
 *
 * Connections are kept alive: pi reuses one connection to SearXNG, and SearXNG
 * pools its engines', so a later call often opens nothing. A connection that
 * matches a call and was already open when it started is listed as the call's
 * `openIds`, a fact about timing, not a claim. Calls that start at the same
 * instant (a batch of parallel calls) share their flows in turn rather than
 * the first taking them all.
 *
 * Calls whose times are only approximate (see `TraceTiming`) join by host,
 * against "had ended by `start`": the flow opened after the turn began and no
 * later than `start` + 2 s, and the first call read after the flow opened wins.
 */
import type { TimelineEvent } from '../events/types.js';
import { TOOL_CALL_TYPES } from '../turns/extract.js';
import { relayOf } from './shell.js';
import type { FlowView, NetService, TraceCall, TraceDownload, TraceItem, TraceTiming } from './types.js';

/** A flow may open this long before its call is recorded as starting (clock skew, recording lag). */
export const JOIN_BEFORE_MS = 1000;
/** …and this long after the call ended (a connection closing, a slow final flush). */
export const JOIN_AFTER_MS = 2000;

const URL_RE = /\bhttps?:\/\/[^\s'"<>`)\]}]+/gi;
const URL_KEYS = ['url', 'uri', 'href', 'link'];
const SEARCH_NAME = /^(web_?search|websearch|search)$/i;
/**
 * The harnesses' own fetch tools: pi's `web_fetch`, Claude Code's `WebFetch`, Vibe's
 * `webfetch_fetch_url` (an MCP `fetch_url`). Only these reach a fetcher sidecar; a
 * shell `curl` names a URL too, but never rides the sidecar's connection.
 */
const FETCH_TOOL = /(^|_)(web_?fetch|fetch_url)$/i;
export const isFetchTool = (toolName: string) => FETCH_TOOL.test(toolName);
/**
 * glove's `web_download` and `web_download_status` (MCP tools of the same fetcher:
 * `mcp__webdownload__web_download` in Claude Code, `webdownload_web_download` in Vibe).
 * They reach the fetcher as `webdownload-mcp`, labelled apart from fetches.
 */
const DOWNLOAD_TOOL = /(^|_)web_?download(_status)?$/i;
export const isDownloadTool = (toolName: string) => DOWNLOAD_TOOL.test(toolName);
const DOWNLOAD_LABEL = 'web_download';

/** A URL's host, lower-case and without IPv6 brackets, and its port only when written out. */
export function urlTarget(raw: string): { host: string; port: number | null } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return null;
  // `URL` drops a port equal to the scheme's default, so `:443` on https reads as unspelled; either way any port matches.
  return { host, port: u.port ? Number(u.port) : null };
}

/**
 * Every URL a call names: `url`-like arguments, a `urls` list, or URLs in a
 * shell command. With `raw`, also the ones that no longer parse — the PII
 * filter turns `http://169.254.169.254/` into `http://[REDACTED]/` — so the
 * call still reads as a fetch of something.
 */
export function urlsOf(input: Record<string, unknown> | undefined, raw = false): string[] {
  if (!input) return [];
  const out: string[] = [];
  for (const k of URL_KEYS) if (typeof input[k] === 'string' && /^https?:\/\//i.test(input[k] as string)) out.push(input[k] as string);
  if (Array.isArray(input.urls)) for (const u of input.urls) if (typeof u === 'string' && /^https?:\/\//i.test(u)) out.push(u);
  if (typeof input.command === 'string') for (const m of (input.command as string).matchAll(URL_RE)) out.push(m[0]);
  // A Pi codemode script: its nested calls' URLs are only in its code.
  if (typeof input.code === 'string') for (const m of (input.code as string).matchAll(URL_RE)) out.push(m[0]);
  const all = [...new Set(out)];
  return raw ? all : all.filter((u) => urlTarget(u) !== null);
}

const REDACTED = /\[REDACTED[^\]]*\]/i;

function isSearch(toolName: string, input: Record<string, unknown> | undefined): boolean {
  return SEARCH_NAME.test(toolName) || (/search/i.test(toolName) && typeof input?.query === 'string');
}

/**
 * A call's times, and how far to trust them: the transcript's own when a
 * passive watcher kept them; the event's own when completion came after the
 * start (a hook harness, or a history import); otherwise only the read time.
 */
export function callTiming(e: Pick<TimelineEvent, 'type' | 'timestamp' | 'data'>): { start: number; end: number | null; timing: TraceTiming } {
  const d = e.data;
  if (typeof d.transcriptAt === 'number') {
    return { start: d.transcriptAt, end: typeof d.transcriptCompletedAt === 'number' ? d.transcriptCompletedAt : null, timing: 'exact' };
  }
  if (typeof d.completedAt === 'number' && d.completedAt > e.timestamp) return { start: e.timestamp, end: d.completedAt, timing: 'exact' };
  // Still pending or approved: a hook recorded it as it started, and it has not ended.
  if (e.type === 'tool_call_pending' || e.type === 'tool_call_approved') return { start: e.timestamp, end: null, timing: 'exact' };
  return { start: e.timestamp, end: e.timestamp, timing: 'approximate' };
}

/** A tool result as text: a string, MCP content blocks (`[{type: "text", text}]`), or `{content: …}`. */
export function outputText(out: unknown, depth = 0): string {
  if (typeof out === 'string') return out;
  if (depth > 3 || out === null || typeof out !== 'object') return '';
  if (Array.isArray(out)) return out.map((x) => outputText(x, depth + 1)).filter(Boolean).join('\n');
  const o = out as Record<string, unknown>;
  if (typeof o.text === 'string') return o.text;
  if ('content' in o) return outputText(o.content, depth + 1);
  return '';
}

const SAVED = /^saved:[ \t]*(\S[^\n]*)$/gm;
const FIELD = (name: string) => new RegExp(`^${name}:[ \\t]*(\\S[^\\n]*)$`, 'm');
/**
 * Vibe's MCP result as it records it: `structured: {'result': '…'}`, a Python repr. The
 * string is single-quoted unless it holds a `'` and no `"`, other keys may come first or
 * after, and a long result may be cut off before its closing quote.
 */
const PY_RESULT = /structured:\s*\{[^\n]*?(['"])result\1\s*:\s*(['"])((?:\\.|(?!\2)[^\\\n])*)(?:\2[^}\n]*\}?)?/g;
const PY_ESCAPE: Record<string, string> = { n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '\\': '\\' };
const pyUnescape = (s: string) => s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, c: string) =>
  c.length > 1 ? String.fromCodePoint(parseInt(c.slice(1), 16)) : PY_ESCAPE[c] ?? `\\${c}`);

/** The text with each Vibe MCP `structured` repr replaced by the string it holds, unescaped. */
function unwrapPyResults(text: string): string {
  return text.replace(PY_RESULT, (_m, _k, _q, inner: string) => pyUnescape(inner));
}

/**
 * The files a `web_download` result reports saved: glove's fetcher writes
 * `saved: /work/downloads/<name>`, then `bytes:`, `sha256:`, `content_type:` and
 * `final_url:` lines (`web_download_status` repeats the block per finished job).
 * Vibe before 2.26 records an MCP result as `structured: {'result': '…'}`, a Python
 * repr whose lines are escaped (glove's `downloads` scenario): it is read unescaped.
 * One file is reported once, however many copies of the result were recorded.
 */
export function downloadsOf(raw: string): TraceDownload[] {
  const text = unwrapPyResults(raw);
  const out: TraceDownload[] = [];
  const seen = new Set<string>();
  const starts = [...text.matchAll(SAVED)];
  starts.forEach((m, i) => {
    const block = text.slice(m.index!, starts[i + 1]?.index ?? text.length);
    const get = (name: string) => FIELD(name).exec(block)?.[1].trim() ?? null;
    const bytes = get('bytes');
    const sha = get('sha256');
    const d: TraceDownload = {
      path: m[1].trim(),
      bytes: bytes && /^\d+$/.test(bytes) ? Number(bytes) : null,
      sha256: sha && /^[0-9a-f]{64}$/i.test(sha) ? sha.toLowerCase() : null,
      contentType: get('content_type'),
      finalUrl: get('final_url'),
    };
    // A result recorded both as text and as a repr reports each file twice.
    const key = `${d.path}:${d.sha256}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  });
  return out;
}

const NESTED_CALL = /\btools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(['"])([^'"]+)\2\s*\])\s*\(/g;
const NESTED_COMMAND = /\bcommand\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * What a Pi codemode script calls: `tools.<name>(…)` (or `tools["<name>"](…)`), and the
 * shell commands it passes (`command: "…"`). pi-codemode runs nested calls inside its VM and
 * only the script's output reaches the transcript, so the code is all there is to read.
 */
export function nestedOf(code: string): { tools: string[]; commands: string[] } {
  const tools = [...new Set([...code.matchAll(NESTED_CALL)].map((m) => m[1] ?? m[3]))];
  const commands = [...code.matchAll(NESTED_COMMAND)].map((m) => m[2].replace(/\\(.)/g, '$1'));
  return { tools, commands };
}

/** The call is (or a codemode script makes) a fetch tool's call, or a download tool's. */
const callsFetch = (c: Pick<TraceCall, 'toolName' | 'nested'>) => isFetchTool(c.toolName) || c.nested.some(isFetchTool);
const callsDownload = (c: Pick<TraceCall, 'toolName' | 'nested'>) => isDownloadTool(c.toolName) || c.nested.some(isDownloadTool);

/** The tool calls among a turn's events, in time order. */
export function callsFrom(events: readonly TimelineEvent[]): TraceCall[] {
  const calls: TraceCall[] = [];
  for (const e of events) {
    if (!TOOL_CALL_TYPES.has(e.type)) continue;
    const toolName = e.data.toolName ?? 'unknown';
    const input = e.data.toolInput;
    const urls = urlsOf(input);
    const named = urlsOf(input, true);
    const search = isSearch(toolName, input);
    const command = typeof input?.command === 'string' ? (input.command as string) : null;
    const nested = typeof input?.code === 'string' ? nestedOf(input.code as string) : { tools: [], commands: [] };
    const relay = command ? relayOf(command) : nested.commands.map(relayOf).find((r) => r !== null) ?? null;
    // A download call names no URL when it asks for a job's status, and still rides the download hop.
    const download = callsDownload({ toolName, nested: nested.tools });
    const kind = search ? 'search' : relay ? 'relay' : named.length || download ? 'fetch' : 'other';
    // A relay call keeps its URLs (and an ssh host) too: with no relay sidecar its traffic goes
    // out through the proxy like any fetch, and `git push && curl …` makes both kinds.
    const hosts = kind === 'fetch' || kind === 'relay' ? urls.filter((u) => !REDACTED.test(u)).map((u) => urlTarget(u)!) : [];
    if (relay?.via === 'ssh' && relay.host) hosts.push({ host: relay.host.toLowerCase(), port: null });
    const label = kind === 'search' ? String(input?.query ?? '')
      : kind === 'fetch' ? named[0] ?? (typeof input?.id === 'string' ? `${toolName} ${input.id}` : toolName)
        : command ? command.slice(0, 120) : toolName;
    calls.push({
      eventId: e.id, sessionId: e.sessionId, toolName, kind, label,
      targets: dedupeTargets(hosts),
      redacted: (kind === 'fetch' || kind === 'relay') && named.some((u) => REDACTED.test(u)),
      ...callTiming(e),
      failed: e.type === 'tool_call_failed' || e.type === 'tool_call_denied' || !!e.data.error,
      relay,
      downloads: download ? downloadsOf(outputText(e.data.toolOutput)) : [],
      nested: nested.tools,
    });
  }
  return calls.sort((a, b) => a.start - b.start);
}

function dedupeTargets(ts: Array<{ host: string; port: number | null }>) {
  const seen = new Set<string>();
  return ts.filter((t) => {
    const k = `${t.host}:${t.port}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * `fetchhop`: the harness's hop to a fetcher sidecar, which fetches (or downloads) on its behalf.
 * `llmhop`: the harness's hop to glove's llm-auth, folded into the request's upstream leg.
 * `github` / `ssh`: a relay sidecar's traffic, made by a shell command.
 */
export type FlowRole = 'llm' | 'llmhop' | 'search' | 'fanout' | 'fetchhop' | 'github' | 'ssh' | 'other';

/** A flow's tool: its own, else the one glove declared for its service. */
function flowTool(f: Pick<FlowView, 'service' | 'tool'>, svc: NetService | undefined): string | null {
  return f.tool ?? svc?.tool ?? null;
}

const serviceOf = (f: Pick<FlowView, 'service'>, services: readonly NetService[]) => services.find((s) => s.service === f.service);

/** What a flow is, from its own fields and the service glove declared for it. */
export function flowRole(f: Pick<FlowView, 'service' | 'tool' | 'client' | 'flags'> & { proto?: string | null }, services: readonly NetService[]): FlowRole {
  if (f.flags.fanout || f.client === 'searxng') return 'fanout';
  const svc = serviceOf(f, services);
  const tool = flowTool(f, svc);
  const client = f.client ?? svc?.client ?? null;
  if (tool === 'llm' || f.service === 'llm') return f.flags.hop ? 'llmhop' : 'llm';
  if (tool === 'web_search') return 'search';
  // A plain TCP listener for web_fetch (or web_download) is a fetcher sidecar; Pi's and
  // Claude Code's `proxy` (an http-proxy) carries the destination itself and joins by host.
  if ((tool === 'web_fetch' || tool === DOWNLOAD_LABEL) && client === 'harness' && (svc?.mode ?? f.proto) === 'tcp') return 'fetchhop';
  if (client === 'github' || tool === 'gh') return 'github';
  if (client === 'ssh' || tool === 'ssh') return 'ssh';
  return 'other';
}

/**
 * How near a flow opened to a call, or null when it is outside the call's
 * window. `from` is the start of the turn: an approximate call's own start is
 * unknown, so the turn bounds it.
 */
export function joinDistance(call: Pick<TraceCall, 'start' | 'end' | 'timing'>, tOpen: number, from: number): number | null {
  if (call.timing === 'exact') {
    if (tOpen < call.start - JOIN_BEFORE_MS) return null;
    if (call.end !== null && tOpen > call.end + JOIN_AFTER_MS) return null;
    return Math.abs(tOpen - call.start);
  }
  if (tOpen < from - JOIN_BEFORE_MS || tOpen > call.start + JOIN_AFTER_MS) return null;
  // Read after the flow opened is the natural order; a read up to the slack before it is tolerated.
  return Math.abs(call.start - tOpen);
}

const targets = (call: TraceCall, f: FlowView) => {
  const host = f.dest.host?.toLowerCase();
  if (!host) return false;
  return call.targets.some((t) => t.host === host && (t.port === null || t.port === f.dest.port));
};

export interface CorrelateInput {
  calls: readonly TraceCall[];
  /** The flows opened in the turn's window. */
  flows: readonly FlowView[];
  /** Flows opened before the window and still open at its start: never claimed, only named in `openIds`. */
  earlier?: readonly FlowView[];
  services: readonly NetService[];
  /** Start of the turn's window. */
  from: number;
}

export interface Correlation {
  items: TraceItem[];
  unattributed: string[];
}

export function correlate({ calls, flows, earlier = [], services, from }: CorrelateInput): Correlation {
  const claimed = new Map<string, { flowIds: string[]; fanoutIds: string[] }>(calls.map((c) => [c.eventId, { flowIds: [], fanoutIds: [] }]));
  const load = (c: TraceCall) => { const x = claimed.get(c.eventId)!; return x.flowIds.length + x.fanoutIds.length; };
  const llm: FlowView[] = [];
  const unattributed: string[] = [];
  const nearest = (cands: TraceCall[], f: FlowView): TraceCall | null => {
    let best: TraceCall | null = null;
    let bestD = Infinity;
    for (const c of cands) {
      const d = joinDistance(c, f.tOpen, from);
      // Equal distance means calls that started together: the one holding fewer flows so far takes it.
      if (d !== null && (d < bestD || (d === bestD && best && load(c) < load(best)))) { best = c; bestD = d; }
    }
    return best;
  };
  // A fetcher sidecar's hop goes to the fetch tool's calls (a download hop to the download
  // tool's); any other flow to the call whose URL names its host. A download's egress
  // (tool `web_download`) is only ever a download call's, and a download call claims nothing else.
  const fetchMayClaim = (call: TraceCall, f: FlowView, role: FlowRole) => {
    const downloadFlow = flowTool(f, serviceOf(f, services)) === DOWNLOAD_LABEL;
    if (role === 'fetchhop') return downloadFlow ? callsDownload(call) : callsFetch(call);
    return role === 'other' && (downloadFlow ? callsDownload(call) : !callsDownload(call) || callsFetch(call)) && targets(call, f);
  };
  // ssh: the call that names the flow's gate (`ssh-<host>`); a host matching no gate (an alias) may claim any ssh flow.
  const sshGates = new Set(services.filter((s) => s.service.startsWith('ssh-')).map((s) => s.service));
  const relayMayClaim = (call: TraceCall, f: FlowView, role: FlowRole) => {
    if (!call.relay) return false;
    if (role === 'github') return call.relay.via === 'github';
    if (role !== 'ssh' || call.relay.via !== 'ssh') return false;
    const gate = `ssh-${call.relay.host}`;
    return gate === f.service || !sshGates.has(gate);
  };
  const searches = calls.filter((c) => c.kind === 'search');
  // A relay call fetches too when it names a host or (a codemode script) calls a fetch or download tool.
  const fetching = (c: TraceCall) => c.kind === 'fetch' || (c.kind === 'relay' && (c.targets.length > 0 || callsFetch(c) || callsDownload(c)));
  const fetches = calls.filter(fetching);
  // A codemode script can relay a command and fetch too: any call with a relay may claim relay flows.
  const relays = calls.filter((c) => c.relay !== null);
  const hops: FlowView[] = [];

  for (const f of [...flows].sort((a, b) => a.tOpen - b.tOpen)) {
    const role = flowRole(f, services);
    if (role === 'llm') { llm.push(f); continue; }
    if (role === 'llmhop') { hops.push(f); continue; }
    if (role === 'search' || role === 'fanout') {
      const c = nearest(searches, f);
      if (c) { claimed.get(c.eventId)![role === 'fanout' ? 'fanoutIds' : 'flowIds'].push(f.id); continue; }
      unattributed.push(f.id);
      continue;
    }
    if (role === 'github' || role === 'ssh') {
      // The exact ssh gate first: `ssh build` and `ssh db` in one window must not swap flows.
      const cands = relays.filter((x) => relayMayClaim(x, f, role));
      const exact = cands.filter((x) => role === 'ssh' && `ssh-${x.relay!.host}` === f.service);
      const c = nearest(exact, f) ?? nearest(cands, f);
      if (c) claimed.get(c.eventId)!.flowIds.push(f.id);
      else unattributed.push(f.id);
      continue;
    }
    const c = nearest(fetches.filter((x) => fetchMayClaim(x, f, role)), f);
    if (c) claimed.get(c.eventId)!.flowIds.push(f.id);
    else unattributed.push(f.id);
  }

  // One row per model request: each hop to llm-auth folds into the nearest upstream leg that
  // opened while it was open, one to one. Whatever is left (a leg kept alive from before
  // the turn, or a hop with no leg yet) is a row of its own.
  const folded = new Map<string, string[]>(llm.map((f) => [f.id, []]));
  const pairs: Array<{ hop: FlowView; leg: FlowView; d: number }> = [];
  for (const hop of hops) {
    for (const leg of llm) {
      if (leg.tOpen < hop.tOpen - JOIN_BEFORE_MS || leg.tOpen > (hop.tClose ?? Infinity) + JOIN_AFTER_MS) continue;
      pairs.push({ hop, leg, d: Math.abs(leg.tOpen - hop.tOpen) });
    }
  }
  const usedHops = new Set<string>();
  for (const p of pairs.sort((a, b) => a.d - b.d || a.hop.tOpen - b.hop.tOpen)) {
    if (usedHops.has(p.hop.id) || folded.get(p.leg.id)!.length) continue;
    folded.get(p.leg.id)!.push(p.hop.id);
    usedHops.add(p.hop.id);
  }
  const llmRows = [
    ...llm.map((f) => ({ at: f.tOpen, flowId: f.id, hopIds: folded.get(f.id)! })),
    ...hops.filter((h) => !usedHops.has(h.id)).map((h) => ({ at: h.tOpen, flowId: h.id, hopIds: [] as string[] })),
  ];

  const byId = new Map([...flows, ...earlier].map((f) => [f.id, f]));
  const openAt = (call: TraceCall): string[] => {
    if (call.timing !== 'exact' || call.kind === 'other') return [];
    const own = claimed.get(call.eventId)!;
    const mine = new Set([...own.flowIds, ...own.fanoutIds]);
    return [...byId.values()]
      .filter((f) => !mine.has(f.id) && f.state !== 'gate_lost' && f.tOpen < call.start && (f.tClose ?? Infinity) >= call.start)
      .filter((f) => {
        const role = flowRole(f, services);
        if (call.kind === 'search') return role === 'search' || role === 'fanout';
        return relayMayClaim(call, f, role) || (fetching(call) && fetchMayClaim(call, f, role));
      })
      .sort((a, b) => a.tOpen - b.tOpen)
      .map((f) => f.id);
  };
  const items: Array<{ at: number; item: TraceItem }> = [
    ...calls.map((call) => ({ at: call.start, item: { kind: 'call' as const, call, ...claimed.get(call.eventId)!, openIds: openAt(call) } })),
    ...llmRows.map((r) => ({ at: r.at, item: { kind: 'llm' as const, flowId: r.flowId, hopIds: r.hopIds } })),
  ];
  // Stable: a call and an LLM flow at the same instant keep calls first.
  items.sort((a, b) => a.at - b.at);
  return { items: items.map((x) => x.item), unattributed };
}
