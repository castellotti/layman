/**
 * glove rounds 1–10 (llm-auth's two-hop model call, the github and ssh relays,
 * `--lan-only`, `web_download`) through the store, the rules and Trace.
 *
 * The records are hand-made (`testing/rounds.ts`). glove's netobs-v3 scenarios for
 * the same cases (round 13) are run in `round13.test.ts`; these stay for what the
 * scenarios do not show (Cut all with open flows, codemode, pooling, history).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../events/types.js';
import { callsFrom, correlate, downloadsOf, flowRole, isDownloadTool, isFetchTool, nestedOf, outputText } from './correlate.js';
import { parseSessionFile } from './parse.js';
import { CUT_PREFIX, applyOp, emptyRules, evaluate, validateRules } from './rules.js';
import { relayOf } from './shell.js';
import { downloadsIn } from './trace.js';
import { NetStore } from './store.js';
import { ROUNDS_FLOWS, ROUNDS_ID, ROUNDS_SERVICES, ROUNDS_T0, roundsRecords, roundsSessionFile } from './testing/rounds.js';
import type { FlowView, RulesFile } from './types.js';
import { nextServices } from './types.js';

const loc = { token: ROUNDS_ID, netDir: '/nonexistent', controlDir: '/nonexistent', rulesPath: '/nonexistent/rules.json' };
const NOW = ROUNDS_T0 + 120_000;

function loaded(): NetStore {
  const store = new NetStore();
  store.ensure(loc);
  store.setSessionFile(ROUNDS_ID, roundsSessionFile(), NOW);
  for (const r of roundsRecords()) store.ingestFlow(ROUNDS_ID, r, NOW);
  return store;
}

const spec = (id: string) => ROUNDS_FLOWS.find((f) => f.id === id)!;

describe('llm-auth: a model call is two flows', () => {
  let store: NetStore;
  beforeEach(() => { store = loaded(); });

  it('knows the hop from session.json: llm goes on through llm-upstream', () => {
    const [llm, upstream] = ROUNDS_SERVICES;
    expect(nextServices(llm, ROUNDS_SERVICES).map((s) => s.service)).toEqual(['llm-upstream']);
    expect(nextServices(upstream, ROUNDS_SERVICES)).toEqual([]);
    // glove's `next`, when it says so, wins over matching by labels.
    const declared = parseSessionFile({ v: 1, services: [{ ...llm, next: [] }, upstream] })!.services;
    expect(nextServices(declared[0], declared)).toEqual([]);
  });

  it('takes glove’s `next` for every sidecar hop, but only to a gate it watches', () => {
    const svc = (service: string, extra: Record<string, unknown> = {}) =>
      ({ service, listen: null, observed: true, harness: true, mode: 'tcp', tool: 'web_fetch', client: 'harness', ...extra });
    const services = parseSessionFile({ v: 1, services: [
      svc('webfetch-mcp', { next: ['webfetch-egress'] }),
      svc('webfetch-egress', { harness: false, client: 'webfetch', next: [] }),
      svc('search-mcp', { tool: 'web_search', next: ['searxng-egress'] }),
      // glove lists a gate the operator skipped: its traffic is unrecorded, so the hop is the record.
      svc('searxng-egress', { harness: false, client: 'searxng', observed: false, next: [] }),
    ] })!.services;
    const by = (n: string) => services.find((s) => s.service === n)!;
    expect(nextServices(by('webfetch-mcp'), services).map((s) => s.service)).toEqual(['webfetch-egress']);
    expect(nextServices(by('webfetch-egress'), services)).toEqual([]);
    expect(nextServices(by('search-mcp'), services)).toEqual([]);
  });

  it('flags the hop, keeps it off the map, and counts each request once in the session totals', () => {
    const snap = store.snapshot(ROUNDS_ID)!;
    const flags = Object.fromEntries(snap.flows.map((f) => [f.id, f.flags.hop]));
    expect([flags.f_hop1, flags.f_hop2, flags.f_leg1, flags.f_leg2, flags.f_dl]).toEqual([true, true, false, false, false]);
    const auth = snap.destinations.find((d) => d.host === `glove-${ROUNDS_ID}-llm-auth`)!;
    expect([auth.flags.hop, auth.flags.unresolved, auth.geo]).toEqual([true, false, null]);
    // The hop's destination keeps its own bytes; the session counts the provider leg only.
    expect(auth.bytesDown).toBe(spec('f_hop1').down + spec('f_hop2').down);
    const counted = ROUNDS_FLOWS.filter((f) => f.service !== 'llm');
    expect(snap.totals.bytesDown).toBe(counted.reduce((a, f) => a + f.down, 0));
    expect(snap.totals.bytesUp).toBe(counted.reduce((a, f) => a + f.up, 0));
    expect(snap.totals.flows).toBe(ROUNDS_FLOWS.length);
  });

  it('gives Trace one LLM row per request, the hop folded into its upstream leg', () => {
    const flows = store.snapshot(ROUNDS_ID)!.flows;
    const r = correlate({ calls: [], flows, services: ROUNDS_SERVICES, from: ROUNDS_T0 - 1000 });
    expect(r.items.filter((i) => i.kind === 'llm')).toEqual([
      { kind: 'llm', flowId: 'f_leg1', hopIds: ['f_hop1'] },
      { kind: 'llm', flowId: 'f_leg2', hopIds: ['f_hop2'] },
    ]);
    expect(r.unattributed.filter((id) => id.startsWith('f_hop') || id.startsWith('f_leg'))).toEqual([]);
  });

  it('keeps a hop whose leg was kept alive from before the turn as a row of its own', () => {
    const flows = store.snapshot(ROUNDS_ID)!.flows.filter((f) => f.id !== 'f_leg2');
    const r = correlate({ calls: [], flows, services: ROUNDS_SERVICES, from: ROUNDS_T0 - 1000 });
    expect(r.items.filter((i) => i.kind === 'llm').map((i) => i.kind === 'llm' && [i.flowId, i.hopIds])).toEqual([
      ['f_leg1', ['f_hop1']], ['f_hop2', []],
    ]);
  });

  it('roles: the hop folds, the leg is the request', () => {
    const view = (id: string) => store.snapshot(ROUNDS_ID)!.flows.find((f) => f.id === id)!;
    expect(flowRole(view('f_hop1'), ROUNDS_SERVICES)).toBe('llmhop');
    expect(flowRole(view('f_leg1'), ROUNDS_SERVICES)).toBe('llm');
  });
});

describe('Cut all traffic', () => {
  const facts = (f: (typeof ROUNDS_FLOWS)[number]) => ({ host: f.host, ip: f.ip, port: f.port, service: f.service, tool: f.tool, scope: f.scope });
  const cut = (keepLlm: boolean) => validateRules(applyOp(emptyRules(ROUNDS_ID, ROUNDS_ID), { kind: 'cutAll', keepLlm }, {
    env: ROUNDS_ID, token: ROUNDS_ID, now: NOW, newId: (() => { let i = 0; return () => `r_${String(++i).padStart(26, '0')}`; })(), currentSha256: null,
  }) as unknown as RulesFile);

  it('blocks every service of llm-auth, the relays and downloads, and cuts the open ones', () => {
    const set = cut(false);
    for (const f of ROUNDS_FLOWS) {
      const v = evaluate(set, facts(f));
      expect([f.id, v.action], f.service).toEqual([f.id, 'block']);
      // Ended, not only refused next time: `lan`/`cloud` cannot be named, so the cut matches the tool.
      expect(v.rule?.startsWith(CUT_PREFIX) && v.terminate, f.id).toBe(true);
    }
  });

  it('keeping the LLM keeps both legs of a model call, and nothing else', () => {
    const set = cut(true);
    const allowed = ROUNDS_FLOWS.filter((f) => evaluate(set, facts(f)).action === 'allow').map((f) => f.service);
    expect([...new Set(allowed)].sort()).toEqual(['llm', 'llm-upstream']);
  });
});

describe('--lan-only', () => {
  it('is glove refusing, not your rule, and its prediction says it cannot be predicted', () => {
    const store = loaded();
    store.setPolicy(ROUNDS_ID, { enforced: validateRules({ v: 1, env: ROUNDS_ID, session: ROUNDS_ID, default: 'allow', rules: [] }), written: null });
    const snap = store.snapshot(ROUNDS_ID)!;
    expect(snap.flows.find((f) => f.id === 'f_lanonly')!.state).toBe('guard');
    expect(snap.totals.blocked).toMatchObject({ guard: 1, userRule: 0 });
    const db = snap.destinations.find((d) => d.host === 'db.example.com')!;
    expect(db.policy.enforced).toEqual({ action: 'allow', rule: null, lanOnly: true });
    expect(snap.destinations.find((d) => d.host === 'build.lan')!.policy.enforced?.lanOnly).toBeUndefined();
  });
});

let n = 0;
function event(toolName: string, toolInput: Record<string, unknown>, start: number, end: number, toolOutput?: unknown): TimelineEvent {
  return {
    id: `ev${++n}`, type: 'tool_call_completed', timestamp: ROUNDS_T0 + end + 1500, sessionId: 's1', agentType: 'pi',
    data: { toolName, toolInput, toolOutput, transcriptAt: ROUNDS_T0 + start, transcriptCompletedAt: ROUNDS_T0 + end },
  };
}

const SAVED = 'saved: /work/downloads/2401.00001.pdf\nbytes: 2400000\nsha256: ' + 'a'.repeat(64)
  + '\ncontent_type: application/pdf\nfinal_url: https://arxiv.org/pdf/2401.00001v2';

describe('Trace: downloads and relays', () => {
  const store = loaded();
  const flows: FlowView[] = store.snapshot(ROUNDS_ID)!.flows;
  const events = [
    event('web_download', { url: 'https://arxiv.org/pdf/2401.00001' }, 4900, 9100, [{ type: 'text', text: SAVED }]),
    // Nearer to the download's egress than the download is: it must not take it.
    event('web_fetch', { url: 'https://arxiv.org/abs/2401.00001' }, 5050, 5200),
    event('bash', { command: 'cd /work/repo && gh pr list --limit 5' }, 10_000, 11_500),
    event('bash', { command: 'echo "gh pr list"' }, 10_100, 10_300),
    event('bash', { command: 'ssh build uptime' }, 12_000, 13_200),
    event('bash', { command: 'ssh -p 2222 db uptime' }, 14_000, 14_200),
  ];
  const calls = callsFrom(events);
  const r = correlate({ calls, flows, services: ROUNDS_SERVICES, from: ROUNDS_T0 - 1000 });
  const claimed = Object.fromEntries(r.items.flatMap((i) => (i.kind === 'call' ? [[i.call.label, i.flowIds]] : [])));

  it('reads calls: a download is a fetch with its saved file, a relayed command is a relay', () => {
    expect(calls.map((c) => [c.toolName, c.kind, c.relay])).toEqual([
      ['web_download', 'fetch', null], ['web_fetch', 'fetch', null],
      ['bash', 'relay', { via: 'github', host: null }], ['bash', 'other', null],
      ['bash', 'relay', { via: 'ssh', host: 'build' }], ['bash', 'relay', { via: 'ssh', host: 'db' }],
    ]);
    expect(calls[0].downloads).toEqual([{
      path: '/work/downloads/2401.00001.pdf', bytes: 2_400_000, sha256: 'a'.repeat(64), contentType: 'application/pdf', finalUrl: 'https://arxiv.org/pdf/2401.00001v2',
    }]);
  });

  it('a download claims its hop and its egress; the fetch beside it claims neither', () => {
    expect(claimed['https://arxiv.org/pdf/2401.00001']).toEqual(['f_dlhop', 'f_dl']);
    expect(claimed['https://arxiv.org/abs/2401.00001']).toEqual([]);
  });

  it('gh claims the GitHub relay\'s flows; a command that only mentions gh does not', () => {
    expect(claimed['cd /work/repo && gh pr list --limit 5']).toEqual(['f_gh']);
    expect(claimed['echo "gh pr list"']).toEqual([]);
  });

  it('ssh claims the flows of the gate it names, the lan-only refusal included', () => {
    expect(claimed['ssh build uptime']).toEqual(['f_ssh']);
    expect(claimed['ssh -p 2222 db uptime']).toEqual(['f_lanonly']);
    expect(r.unattributed).toEqual([]);
  });

  // A script that relays a command and downloads too keeps both: the download's hop and egress, and the relay's flow.
  it('a codemode script that relays and downloads claims both kinds of flow', () => {
    const code = 'await tools.web_download({ url: "https://arxiv.org/pdf/2401.00001" });\nawait tools.bash({ command: "gh pr list" });';
    const cs = callsFrom([event('codemode', { code }, 4900, 11_500)]);
    expect(cs.map((c) => c.kind)).toEqual(['relay']);
    const j = correlate({ calls: cs, flows, services: ROUNDS_SERVICES, from: ROUNDS_T0 - 1000 });
    const item = j.items.find((i) => i.kind === 'call');
    expect(item?.kind === 'call' && item.flowIds).toEqual(['f_dlhop', 'f_dl', 'f_gh']);
  });
});

describe('reading tool names, commands and results', () => {
  it('keeps download tools apart from fetch tools, in every harness\'s spelling', () => {
    for (const t of ['web_download', 'web_download_status', 'mcp__webdownload__web_download', 'webdownload_web_download_status']) {
      expect([t, isDownloadTool(t), isFetchTool(t)]).toEqual([t, true, false]);
    }
    for (const t of ['web_fetch', 'WebFetch', 'webfetch_fetch_url']) expect([t, isDownloadTool(t)]).toEqual([t, false]);
  });

  it('lists a session\'s saved files once, under the call that first reported them', () => {
    const evs = [
      event('web_download', { url: 'https://arxiv.org/pdf/2401.00001' }, 4900, 9100, [{ type: 'text', text: 'started: d1 → /work/downloads/2401.00001.pdf' }]),
      event('web_download_status', { id: 'd1' }, 30_000, 30_100, SAVED),
      event('web_download_status', {}, 40_000, 40_100, SAVED),
    ];
    const deps = { sessionsNamed: () => ['s1'], events: () => evs, session: () => ({ turns: [], events: evs }) };
    expect(downloadsIn(loaded(), ROUNDS_ID, deps)).toEqual([expect.objectContaining({
      path: '/work/downloads/2401.00001.pdf', eventId: evs[1].id, toolName: 'web_download_status', url: null, at: ROUNDS_T0 + 30_000,
    })]);
    expect(downloadsIn(loaded(), 'nope', deps)).toBeNull();
  });

  it('lets a status call (no URL) claim the download hop', () => {
    const [c] = callsFrom([event('web_download_status', { id: 'd1' }, 0, 100, 'started: d1 …')]);
    expect([c.kind, c.label, c.targets, c.downloads]).toEqual(['fetch', 'web_download_status d1', [], []]);
  });

  it.each([
    ['gh pr list', { via: 'github', host: null }],
    ['GH_PAGER=cat gh api repos/o/r', { via: 'github', host: null }],
    ['git -C /work/repo push origin main', { via: 'github', host: null }],
    ['git pull --rebase', { via: 'github', host: null }],
    ['git clone https://github.com/o/r', { via: 'github', host: null }],
    ['cd x; git ls-remote origin', { via: 'github', host: null }],
    ['git status && git log', null],
    ['git commit -m "git push later"', null],
    ['ssh build uptime', { via: 'ssh', host: 'build' }],
    ['ssh -o BatchMode=yes -i key me@build "uptime"', { via: 'ssh', host: 'build' }],
    ['time ssh -p2222 db', { via: 'ssh', host: 'db' }],
    ['echo gh', null],
    ['grep -r "ssh build" .', null],
    ["echo 'a && gh pr list'", null],
    ['ls | gh issue list', { via: 'github', host: null }],
  ])('%s', (command, want) => {
    expect(relayOf(command)).toEqual(want);
  });

  // pi-codemode runs nested calls in its VM: the transcript has one `codemode` call with `code`.
  it('reads a Pi codemode script\'s nested tools, URLs and shell commands from its code', () => {
    const code = 'const a = await tools.web_fetch({ url: "https://arxiv.org/abs/1" });\n'
      + 'await tools["web_download"]({ url: "https://arxiv.org/pdf/1" });\nawait tools.bash({ command: "gh pr list" });';
    expect(nestedOf(code)).toEqual({ tools: ['web_fetch', 'web_download', 'bash'], commands: ['gh pr list'] });
    const [c] = callsFrom([event('codemode', { code }, 0, 100)]);
    expect([c.kind, c.nested, c.relay, c.targets.map((t) => t.host)]).toEqual(['relay', ['web_fetch', 'web_download', 'bash'], { via: 'github', host: null }, ['arxiv.org']]);
    const [f] = callsFrom([event('codemode', { code: 'return tools.web_fetch({ url: "https://arxiv.org/abs/1" })' }, 0, 100)]);
    expect([f.kind, f.targets]).toEqual(['fetch', [{ host: 'arxiv.org', port: null }]]);
  });

  it('reads MCP content blocks and plain strings alike', () => {
    expect(outputText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(outputText({ content: [{ type: 'text', text: 'c' }] })).toBe('c');
    expect(outputText('d')).toBe('d');
    // web_download_status lists several jobs.
    expect(downloadsOf(`${SAVED}\n\nsaved: /work/downloads/b.zip\nbytes: 12\nsha256: nope`).map((d) => [d.path, d.bytes, d.sha256]))
      .toEqual([['/work/downloads/2401.00001.pdf', 2_400_000, 'a'.repeat(64)], ['/work/downloads/b.zip', 12, null]]);
  });
});
