/**
 * Blocking and unblocking as data:
 * what a row's toggle shows, what clicking it offers, the operation each choice
 * sends, and the Rules panel's draft. Pure, so it is tested in node.
 *
 * The server decides what the gate enforces and predicts each destination's
 * verdict (`DestinationAggregate.policy`); this module only reads that. The one
 * piece of rule logic it repeats is `previewRules`, the JSON the Block popover
 * shows before anything is written — mirrored from the server's `opRules` and
 * held to it by a test.
 */
import { BLOCK_STATES, type ToggleKind } from './net-format.js';
import type { DestinationAggregate, GroupKey, PolicyVerdict, Rule, RuleAction, RulesFile, RulesOp, RulesView } from './netobs-types.js';

/** Rule ids of a "Cut all traffic" set (server `CUT_PREFIX`). */
export const CUT_PREFIX = 'r_layman_cut_';

const same = (a: PolicyVerdict | null, b: PolicyVerdict | null) => a?.action === b?.action && a?.rule === b?.rule;

/**
 * A destination's toggle. The predicted verdict under the *enforced* rules
 * decides it, so the toggle shows what the gate does, not what Layman wrote;
 * while the file on disk says otherwise it is `pending`. Without a prediction
 * (the enforced set unknown) the observed state decides, as before.
 */
export function toggleFor(d: Pick<DestinationAggregate, 'state' | 'flags' | 'policy'>): ToggleKind {
  if (d.state === 'empty') return 'none';
  if (d.state === 'guard' || d.flags.noHost) return 'locked';
  const { enforced, written } = d.policy;
  if (enforced && written && !same(enforced, written)) return 'pending';
  if (enforced) return enforced.action === 'allow' ? 'allow' : enforced.rule ? 'block' : 'default';
  if (d.state === 'user_rule') return 'block';
  if (d.state === 'default_block') return 'default';
  return 'allow';
}

/**
 * Blocked flows per rule id, for the Rules panel. Exact for the flows the files hold
 * (`blockedBy`); blocks only the kept history knows (files since deleted) carry no rule,
 * so they are put on the destination's latest one, as an estimate.
 */
export function ruleHits(dests: Iterable<Pick<DestinationAggregate, 'blocked' | 'blockedBy' | 'rule'>>): Map<string, number> {
  const m = new Map<string, number>();
  const add = (rule: string, n: number) => m.set(rule, (m.get(rule) ?? 0) + n);
  for (const d of dests) {
    let known = 0;
    for (const [rule, n] of Object.entries(d.blockedBy ?? {})) {
      known += n;
      if (rule) add(rule, n);
    }
    if (d.rule && d.blocked > known) add(d.rule, d.blocked - known);
  }
  return m;
}

/** Why toggles cannot act, or null when they can. */
export function controlDisabledReason(rules: RulesView): string | null {
  if (rules.control.state !== 'ok') return rules.control.detail || 'Layman cannot change this session’s rules.';
  if (rules.invalid) return `rules.json is invalid (${rules.invalid}). Fix it, or revert to the rules the gate enforces.`;
  if (rules.write && (rules.write.state === 'pending')) return 'Waiting for the gate to confirm the last change.';
  return null;
}

// ─── Operations ───────────────────────────────────────────────────────────────

export type BlockScope = 'host' | 'domain' | 'ip';

export interface BlockChoice {
  scope: BlockScope;
  label: string;
  /** The match(es), as the popover's second line shows them. */
  detail: string;
  warning: string | null;
}

/** Registrable domains group IPs and private names under themselves: those have no "and every subdomain". */
const isDomain = (groupKey: string) => groupKey.includes('.') && !/^[\d.]+$/.test(groupKey) && !groupKey.includes(':');

export function blockChoices(d: Pick<DestinationAggregate, 'host' | 'groupKey' | 'ips'>): BlockChoice[] {
  const out: BlockChoice[] = [];
  if (d.host) out.push({ scope: 'host', label: 'This host only', detail: `host ${d.host}`, warning: null });
  if (isDomain(d.groupKey)) {
    out.push({
      scope: 'domain', label: `${d.groupKey} and every subdomain`,
      detail: `host ${d.groupKey} + host *.${d.groupKey} (2 rules)`, warning: null,
    });
  }
  if (d.ips[0] && d.ips[0] !== d.host) {
    out.push({
      scope: 'ip', label: 'This IP address', detail: `ip ${d.ips[0]}`,
      warning: 'Shared CDN address. Other sites may be blocked too.',
    });
  }
  return out;
}

export function blockOp(d: Pick<DestinationAggregate, 'host' | 'groupKey' | 'ips'>, scope: BlockScope, terminate: boolean, note: string): RulesOp {
  const n = note.trim() || undefined;
  if (scope === 'domain') return { kind: 'blockDomain', apex: d.groupKey, terminate, note: n };
  if (scope === 'ip') return { kind: 'blockIp', ip: d.ips[0], terminate, note: n };
  return { kind: 'blockHost', host: d.host!, terminate, note: n };
}

/** A group toggle writes one rule over the group: fan-out, local links, a route or a tool. */
export interface GroupTarget {
  key: GroupKey;
  value: string;
  label: string;
  warning: string | null;
}

export function groupTarget(groupKey: string, label: string): GroupTarget | null {
  if (groupKey === '@fanout') return { key: 'tool', value: 'search-engine-fanout', label, warning: null };
  if (groupKey === '@local') {
    return { key: 'scope', value: 'local', label, warning: 'Also cuts the LLM. The agent will stop responding.' };
  }
  if (groupKey === 'route:Direct') return { key: 'scope', value: 'direct', label, warning: null };
  if (groupKey === 'route:VPN' || groupKey === 'route:Tor' || groupKey === 'route:tunnel') {
    return { key: 'scope', value: 'tunnelled', label: 'Everything tunnelled', warning: null };
  }
  if (groupKey.startsWith('tool:') && groupKey !== 'tool:unknown') return { key: 'tool', value: groupKey.slice(5), label, warning: null };
  return null;
}

/** The rules an operation would add, without ids: the Block popover's preview (server `opRules`). */
export function previewRules(op: RulesOp): Array<Omit<Rule, 'id'>> {
  const withNote = <T extends object>(r: T, note?: string) => (note ? { ...r, note } : r);
  switch (op.kind) {
    case 'blockHost':
      return [withNote({ action: 'block' as const, match: { host: op.host.toLowerCase() }, terminate: op.terminate }, op.note)];
    case 'blockDomain':
      return [
        withNote({ action: 'block' as const, match: { host: op.apex.toLowerCase() }, terminate: op.terminate }, op.note),
        withNote({ action: 'block' as const, match: { host: `*.${op.apex.toLowerCase()}` }, terminate: op.terminate }, op.note),
      ];
    case 'blockIp':
      return [withNote({ action: 'block' as const, match: { ip: op.ip }, terminate: op.terminate }, op.note)];
    case 'blockGroup':
      return [withNote({ action: 'block' as const, match: { [op.key]: op.value }, terminate: op.terminate }, op.note)];
    case 'allowHost':
      return [withNote({ action: 'allow' as const, match: { host: op.host.toLowerCase() } }, op.note)];
    case 'allowDomain':
      return [
        withNote({ action: 'allow' as const, match: { host: op.apex.toLowerCase() } }, op.note),
        withNote({ action: 'allow' as const, match: { host: `*.${op.apex.toLowerCase()}` } }, op.note),
      ];
    case 'cutAll': {
      const cut = (scope: string) => ({ action: 'block' as const, match: { scope }, terminate: true });
      return [...(op.keepLlm ? [{ action: 'allow' as const, match: { service: 'llm' } }] : []), cut('tunnelled'), cut('direct'), cut('local')];
    }
    default:
      return [];
  }
}

/** The preview as the popover prints it: one compact object per line. */
export function previewText(op: RulesOp): string {
  return previewRules(op).map((r) => JSON.stringify(r).replace(/([{,:])/g, '$1 ').replace(/}/g, ' }')).join(',\n');
}

// ─── Rules in the file ────────────────────────────────────────────────────────

/** The other rule of a domain pair (`<stem>-apex` / `<stem>-sub`), which removing one should offer to remove too. */
export function siblingIds(id: string, rules: readonly Rule[]): string[] {
  const m = /^(.*)-(apex|sub)$/.exec(id);
  if (!m) return [id];
  return rules.map((r) => r.id).filter((x) => x === `${m[1]}-apex` || x === `${m[1]}-sub`);
}

/** Destinations a rule decides now (under the enforced set): what "Remove the rule" would unblock. */
export function decidedBy(ruleIds: readonly string[], dests: Iterable<DestinationAggregate>): DestinationAggregate[] {
  const ids = new Set(ruleIds);
  return [...dests].filter((d) => d.policy.enforced?.rule && ids.has(d.policy.enforced.rule));
}

/**
 * Who wrote the rules.json glove rejected: Layman, when its own last write is
 * the file on disk; someone else, when Layman saw the file change without
 * writing it or the file names another writer; otherwise unknown (e.g. Layman
 * started after the change). The banner must not say "your change" for a
 * hand edit.
 */
export function rejectedAuthor(view: Pick<RulesView, 'sha256' | 'write' | 'externalChange' | 'file'>): 'layman' | 'outside' | 'unknown' {
  if (view.sha256 === null) return 'unknown';
  if (view.write?.sha256 === view.sha256) return 'layman';
  if (view.externalChange?.sha256 === view.sha256) return 'outside';
  const by = view.file?.updated_by;
  return by && by !== 'layman' ? 'outside' : 'unknown';
}

/** The rejected banner's headline, by who wrote the file. */
export const REJECTED_TITLE: Record<ReturnType<typeof rejectedAuthor>, string> = {
  layman: 'Your last rules change did not take effect',
  outside: 'rules.json was changed outside Layman, and glove rejected it',
  unknown: 'The last change to rules.json did not take effect',
};

export function isCut(file: RulesFile | null): boolean {
  return !!file?.rules.some((r) => r.id.startsWith(CUT_PREFIX));
}

/** Open connections a kill switch would end: live flows not on the LLM link when it is kept. */
export function openToCut(dests: Iterable<DestinationAggregate>, keepLlm: boolean): number {
  let n = 0;
  for (const d of dests) if (!(keepLlm && d.services.includes('llm'))) n += d.openFlows;
  return n;
}

export { BLOCK_STATES };

// ─── The Rules panel's draft ──────────────────────────────────────────────────

export interface Draft {
  /** SHA-256 of the file the draft was made from; saving onto any other file is refused. */
  base: string | null;
  /** The file's rules when the draft was made (or last rebased), to tell the user's edits from the file's. */
  baseRules: Rule[];
  baseDefault: RuleAction;
  rules: Rule[];
  default: RuleAction;
}

export function startDraft(view: RulesView): Draft {
  const file = view.file;
  const rules = file?.rules ?? [];
  const def = file?.default ?? 'allow';
  return { base: view.sha256, baseRules: rules, baseDefault: def, rules: [...rules], default: def };
}

export function isDirty(d: Draft): boolean {
  return d.default !== d.baseDefault || JSON.stringify(d.rules) !== JSON.stringify(d.baseRules);
}

/**
 * The file changed under an open draft: keep the user's edits, on the new file.
 * Rules the user added stay on top in their order, rules they deleted stay
 * deleted, everything else (including another writer's new rules) comes from
 * the new file in its order, and the default is theirs only if they changed it.
 */
export function rebaseDraft(d: Draft, view: RulesView): Draft {
  const next = view.file?.rules ?? [];
  const nextDefault = view.file?.default ?? 'allow';
  const baseIds = new Set(d.baseRules.map((r) => r.id));
  const draftIds = new Set(d.rules.map((r) => r.id));
  const added = d.rules.filter((r) => !baseIds.has(r.id));
  const removed = new Set(d.baseRules.filter((r) => !draftIds.has(r.id)).map((r) => r.id));
  const edited = new Map(d.rules.filter((r) => baseIds.has(r.id)).map((r) => [r.id, r]));
  const kept = next.filter((r) => !removed.has(r.id)).map((r) => edited.get(r.id) ?? r);
  return {
    base: view.sha256,
    baseRules: next,
    baseDefault: nextDefault,
    rules: [...added, ...kept],
    default: d.default !== d.baseDefault ? d.default : nextDefault,
  };
}

export function moveRule(rules: readonly Rule[], fromId: string, toId: string): Rule[] {
  const from = rules.findIndex((r) => r.id === fromId);
  const to = rules.findIndex((r) => r.id === toId);
  if (from < 0 || to < 0 || from === to) return [...rules];
  const out = [...rules];
  const [r] = out.splice(from, 1);
  out.splice(to, 0, r);
  return out;
}

/** A client-side id for a rule added in the draft: valid for the gate, unique enough, and never reused. */
export function draftRuleId(now: number, taken: ReadonlySet<string>): string {
  for (let i = 0; ; i++) {
    const id = `r_${now.toString(36).toUpperCase()}${i.toString(36).toUpperCase().padStart(3, '0')}`;
    if (!taken.has(id)) return id;
  }
}

export type MatchKey = 'host' | 'ip' | 'port' | 'service' | 'tool' | 'scope';

/** A quick check of the Add rule form, before the server's (authoritative) validator sees it. */
export function checkMatchValue(key: MatchKey, value: string): string | null {
  const v = value.trim();
  if (!v) return 'Enter a value.';
  switch (key) {
    case 'host':
      return /^[a-z0-9*?._-]{1,253}$/i.test(v) ? null : 'Hosts use letters, digits, . _ - and the globs * ?';
    case 'port':
      return /^\d{1,5}(-\d{1,5})?$/.test(v) ? null : 'A port (443) or a range (8000-8100).';
    case 'scope':
      return ['local', 'tunnelled', 'direct'].includes(v) ? null : 'One of local, tunnelled, direct.';
    case 'service':
    case 'tool':
      return /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? null : 'Letters, digits, . _ - only.';
    case 'ip':
      return /^[0-9a-fA-F:.%/]+$/.test(v) ? null : 'An IP address or CIDR.';
  }
}

/** The match object for a form value (a single port becomes a number, as the gate expects). */
export function matchFor(key: MatchKey, value: string): Rule['match'] {
  const v = value.trim();
  return { [key]: key === 'port' && /^\d+$/.test(v) ? Number(v) : v };
}
