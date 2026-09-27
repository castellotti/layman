/**
 * The Rules panel: whether the gate enforces what is on disk,
 * the evaluation order (glove's guard first and locked, then rules.json top to
 * bottom), a draft to edit it — reorder, delete, add, change the default — and
 * the kill switch. A draft is saved as one write, and only onto the file it was
 * made from; when the file changes underneath it, the draft is rebased and the
 * user is told.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNetStore } from '../../stores/netStore.js';
import { useDragReorder } from '../../hooks/useDragReorder.js';
import type { NetSessionData } from '../../lib/net-state.js';
import { clockTime, matchText } from '../../lib/net-table.js';
import {
  CUT_PREFIX, checkMatchValue, controlDisabledReason, draftRuleId, isCut, isDirty, matchFor, moveRule, openToCut,
  rebaseDraft, ruleHits, startDraft, type Draft, type MatchKey,
} from '../../lib/net-rules.js';
import type { Rule, RuleAction } from '../../lib/netobs-types.js';
import { buttonStyle } from './ControlPopover.js';
import { NetIcon, type NetIconName } from './netui.js';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sectionTitle: React.CSSProperties = { fontSize: 10, letterSpacing: '0.08em', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 };

type Tone = 'ok' | 'error' | 'warn' | 'neutral';
const TONES: Record<Tone, { bg: string; border: string; icon: NetIconName; colour: string }> = {
  ok: { bg: 'rgba(76,195,138,0.08)', border: 'rgba(76,195,138,0.3)', icon: 'check', colour: 'var(--ok)' },
  error: { bg: 'rgba(240,86,74,0.10)', border: 'rgba(240,86,74,0.5)', icon: 'alert', colour: 'var(--error)' },
  warn: { bg: 'rgba(229,168,59,0.10)', border: 'rgba(229,168,59,0.45)', icon: 'clock', colour: 'var(--warn)' },
  neutral: { bg: 'rgba(255,255,255,0.03)', border: 'var(--border-strong)', icon: 'shield', colour: 'var(--text-muted)' },
};

function StatusBox({ tone, title, sub, role }: { tone: Tone; title: React.ReactNode; sub: React.ReactNode; role?: string }) {
  const c = TONES[tone];
  return (
    <div role={role} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', borderRadius: 6, background: c.bg, border: `1px solid ${c.border}`, marginBottom: 10 }}>
      <NetIcon name={c.icon} color={c.colour} />
      <div style={{ fontSize: 11, color: 'var(--text-body)', minWidth: 0 }}>
        <div style={{ fontWeight: tone === 'neutral' || tone === 'ok' ? 400 : 600, color: tone === 'error' ? '#FFB4AD' : tone === 'warn' ? 'var(--warn)' : undefined }}>{title}</div>
        <div style={{ fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.45 }}>{sub}</div>
      </div>
    </div>
  );
}

/** What the gate makes of the file, preferring the story of Layman's own last write while it is recent. */
function enforcementBox(data: NetSessionData, now: number): React.ReactNode {
  const status = data.gate.rules;
  const view = data.rules;
  const w = view.write;
  const recent = w && now - w.at < 60_000;
  const at = (ms: number) => <span style={{ fontFamily: 'var(--font-mono)' }}>{clockTime(ms)}</span>;
  if (w && (w.state === 'pending' || w.state === 'unconfirmed' || w.state === 'rejected' || w.state === 'failed' || (recent && w.state !== 'enforced'))) {
    switch (w.state) {
      case 'pending':
        return <StatusBox tone="warn" title="Waiting for the gate" sub={<>Wrote rules.json at {at(w.at)}. glove polls about once a second; status.json confirms within about 5 s.</>} />;
      case 'unconfirmed':
        return <StatusBox tone="warn" title="The gate hasn’t picked this up" sub={data.gate.freshness === 'running'
          ? <>Written at {at(w.at)}; no confirmation yet. It may be stopped or slow.</>
          : <>Written at {at(w.at)}, but the gate is {data.gate.freshness}: nothing will confirm it until it runs.</>} />;
      case 'rejected':
        return <StatusBox role="alert" tone="error" title="Not enforced: glove rejected the file"
          sub={<>{w.error ?? 'No reason given'}. The previous {plural(status?.active_count ?? 0, 'rule')} {status?.active_count === 1 ? 'is' : 'are'} still in force.</>} />;
      case 'failed':
        return <StatusBox role="alert" tone="error" title="Layman could not write rules.json" sub={w.error ?? 'Unknown error.'} />;
      case 'superseded':
        return <StatusBox tone="neutral" title="Another writer replaced Layman’s change" sub="rules.json changed before the gate read Layman’s write; what is shown is the file now." />;
    }
  }
  if (!status) return <StatusBox tone="neutral" title="The gate has not reported its rules" sub="No status.json has been read for this session." />;
  if (!status.ok) {
    const unreadable = status.error?.startsWith('cannot read');
    return (
      <StatusBox role="alert" tone="error"
        title={unreadable ? 'The gate cannot read rules.json' : 'Not enforced: glove rejected rules.json'}
        sub={`${unreadable ? 'Almost always ownership: the gate runs as your user and must be able to read the file. ' : `${status.error ?? 'No reason given'}. `}The previous ${plural(status.active_count, 'rule')} ${status.active_count === 1 ? 'is' : 'are'} still enforced.`} />
    );
  }
  if (!view.exists) return <StatusBox tone="neutral" title="No rules.json" sub="Everything is allowed unless glove’s guard refuses it." />;
  if (view.enforcement === 'pending') return <StatusBox tone="warn" title="Waiting for the gate" sub="rules.json changed; the gate has not confirmed these bytes yet." />;
  return (
    <StatusBox tone="ok"
      title={<>Enforced by the gate{status.loaded_at ? <> · loaded {at(Date.parse(status.loaded_at))}</> : null}</>}
      sub={w?.state === 'enforced' && recent ? 'Your change is in force.' : 'glove re-reads rules.json about once a second'} />
  );
}

function RuleRow({ index, rule, hits, locked, unsaved, editable, drag, dropTarget, onDelete }: {
  index: number;
  rule: Pick<Rule, 'action' | 'match' | 'note' | 'terminate'> & { id?: string };
  hits: number | null;
  locked?: boolean;
  unsaved?: boolean;
  editable: boolean;
  drag?: { onDragStart: () => void; onDragOver: () => void; onDragEnd: () => void };
  dropTarget?: boolean;
  onDelete?: () => void;
}) {
  const match = locked ? 'internal, metadata, malformed' : matchText(rule);
  const sub = locked ? 'glove built-in guard, runs first' : unsaved ? 'added just now, not saved' : rule.note ?? rule.id ?? '';
  return (
    <div
      onDragOver={drag ? (e) => { e.preventDefault(); drag.onDragOver(); } : undefined}
      onDrop={drag ? (e) => { e.preventDefault(); drag.onDragEnd(); } : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 6, background: 'var(--bg)',
        border: `1px ${unsaved ? 'dashed var(--warn)' : `solid ${dropTarget ? 'var(--accent)' : 'var(--border)'}`}`,
      }}
    >
      {locked ? <NetIcon name="lock" color="var(--warn)" />
        : editable && drag ? (
          <span draggable title="Drag to reorder" aria-label="Drag to reorder" onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; drag.onDragStart(); }} onDragEnd={drag.onDragEnd} style={{ cursor: 'grab' }}>
            <NetIcon name="grip" color="var(--text-faint)" />
          </span>
        ) : <span style={{ width: 12 }} />}
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', width: 12 }}>{index}</span>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', color: rule.action === 'allow' ? 'var(--net-tunnel)' : 'var(--error)', width: 38 }}>
        {rule.action.toUpperCase()}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={match}>{match}</div>
        <div style={{ fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
      </div>
      {rule.terminate && !locked && <Badge>CUTS OPEN</Badge>}
      {unsaved && <Badge>UNSAVED</Badge>}
      {hits !== null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{unsaved ? '—' : plural(hits, 'hit')}</span>}
      {locked && <span style={{ fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>not editable</span>}
      {editable && onDelete && (
        <button type="button" aria-label={`Delete rule ${match}`} onClick={onDelete} style={{ background: 'transparent', border: 'none', padding: 2, cursor: 'pointer' }}>
          <NetIcon name="close" size={11} color="var(--text-faint)" />
        </button>
      )}
    </div>
  );
}

const Badge = ({ children }: { children: React.ReactNode }) => (
  <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--warn)', border: '1px solid rgba(229,168,59,0.45)', background: 'rgba(229,168,59,0.1)', borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap' }}>
    {children}
  </span>
);

const MATCH_KEYS: MatchKey[] = ['host', 'ip', 'port', 'service', 'tool', 'scope'];
const inputStyle: React.CSSProperties = {
  height: 26, padding: '0 7px', fontSize: 11, borderRadius: 5, background: 'var(--bg)', border: '1px solid var(--border-strong)',
  color: 'var(--text)', outline: 'none', fontFamily: 'var(--font-ui)', minWidth: 0,
};

/** Add rule: the permitted match keys only (glove's record contract), checked before the server's validator sees it. */
function AddRuleForm({ onAdd, onCancel }: { onAdd: (rule: Omit<Rule, 'id'>) => void; onCancel: () => void }) {
  const [action, setAction] = useState<RuleAction>('block');
  const [key, setKey] = useState<MatchKey>('host');
  const [value, setValue] = useState('');
  const [terminate, setTerminate] = useState(false);
  const [note, setNote] = useState('');
  const error = value ? checkMatchValue(key, value) : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <select aria-label="Action" value={action} onChange={(e) => setAction(e.target.value as RuleAction)} style={inputStyle}>
          <option value="block">Block</option>
          <option value="allow">Allow</option>
        </select>
        <select aria-label="Match on" value={key} onChange={(e) => setKey(e.target.value as MatchKey)} style={inputStyle}>
          {MATCH_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input aria-label="Match value" value={value} onChange={(e) => setValue(e.target.value)} placeholder={key === 'host' ? '*.example.com' : key === 'port' ? '443 or 8000-8100' : key === 'scope' ? 'tunnelled' : ''}
          style={{ ...inputStyle, flex: 1, fontFamily: 'var(--font-mono)' }} />
      </div>
      <input aria-label="Rule note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (optional)" style={inputStyle} />
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-body)' }}>
        <input type="checkbox" checked={terminate} onChange={(e) => setTerminate(e.target.checked)} />Also cut matching connections that are open
      </label>
      {error && <div style={{ fontSize: 10.5, color: 'var(--warn)' }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button type="button" onClick={onCancel} style={buttonStyle('ghost')}>Cancel</button>
        <button type="button" disabled={!value || !!error} style={buttonStyle('plain')} onClick={() => onAdd({
          action, match: matchFor(key, value), ...(terminate ? { terminate } : {}), ...(note.trim() ? { note: note.trim() } : {}),
        })}>Add to draft</button>
      </div>
    </div>
  );
}

/** "Cut all traffic now": confirm, with "keep the LLM link open" checked by default. */
function KillSwitchDialog({ data, onClose }: { data: NetSessionData; onClose: () => void }) {
  const [keepLlm, setKeepLlm] = useState(true);
  const n = openToCut(data.destinations.values(), keepLlm);
  return (
    <div role="presentation" onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div role="alertdialog" aria-label={`Cut all traffic for ${data.token}?`} onClick={(e) => e.stopPropagation()} style={{
        width: 420, padding: 16, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border-strong)', boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
          <NetIcon name="cut" color="var(--error)" size={14} />Cut all traffic for {data.token}?
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
          Sets the default to block and ends {plural(n, 'open connection')}. Nothing leaves the sandbox until you restore it.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-body)', marginBottom: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={keepLlm} onChange={(e) => setKeepLlm(e.target.checked)} />
          Keep the LLM link open so the agent can still answer
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button type="button" onClick={onClose} style={buttonStyle('ghost')}>Cancel</button>
          <button type="button" autoFocus onClick={() => { useNetStore.getState().applyRules({ kind: 'cutAll', keepLlm }); onClose(); }} style={buttonStyle('danger')}>
            <NetIcon name="cut" color="#FF8A80" />Cut all traffic
          </button>
        </div>
      </div>
    </div>
  );
}

export function RulesPanel({ data, now }: { data: NetSessionData; now: number }) {
  const view = data.rules;
  const ops = useNetStore((s) => s.ops);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState(false);
  const [showFile, setShowFile] = useState(false);
  const [adding, setAdding] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [savingOp, setSavingOp] = useState<string | null>(null);
  const draftIds = useRef(new Set<string>());

  const disabledReason = controlDisabledReason(view);
  const rejected = data.gate.rules?.ok === false;
  const cut = isCut(view.file);

  // The file changed under an open draft: keep the user's edits, on the new file, and say so.
  useEffect(() => {
    if (draft && view.sha256 !== draft.base && savingOp === null) {
      setDraft(rebaseDraft(draft, view));
      setConflict(true);
    }
  }, [view.sha256]); // eslint-disable-line react-hooks/exhaustive-deps

  // A saved draft is done once the write reached disk; a refused one stays for the user to fix.
  useEffect(() => {
    const r = savingOp ? ops[savingOp] : undefined;
    if (!r || r.ok === null) return;
    if (r.ok) {
      setDraft(null);
      setConflict(false);
    }
    setSavingOp(null);
  }, [ops, savingOp]);

  const hits = useMemo(() => ruleHits(data.destinations.values()), [data.destinations]);

  // Editing a draft needs a writable, valid file; a write waiting for the gate does not block it.
  const editable = view.control.state === 'ok' && !view.invalid;
  const d = draft ?? startDraft(view);
  const edit = (next: Partial<Draft>) => setDraft({ ...d, ...next });
  const drag = useDragReorder((from, to) => edit({ rules: moveRule(d.rules, from, to) }));
  const baseIds = new Set(d.baseRules.map((r) => r.id));
  const dirty = draft !== null && isDirty(draft);

  const save = () => {
    const opId = useNetStore.getState().applyRules({ kind: 'saveDraft', baseSha256: d.base, default: d.default, rules: d.rules });
    setSavingOp(opId);
  };

  return (
    <div style={{ padding: 10 }}>
      {enforcementBox(data, now)}
      {conflict && dirty && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', borderRadius: 6, background: 'rgba(229,168,59,0.10)', border: '1px solid rgba(229,168,59,0.45)', marginBottom: 10 }}>
          <NetIcon name="alert" color="var(--warn)" />
          <div style={{ flex: 1, fontSize: 11, color: 'var(--text-body)' }}>
            <div style={{ fontWeight: 600, color: 'var(--warn)' }}>Your unsaved change conflicts</div>
            <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>The file changed while you were editing. Layman re-read it and kept your draft on top.</div>
          </div>
          <button type="button" onClick={() => setShowFile((v) => !v)} style={buttonStyle('plain')}>{showFile ? 'Hide' : 'Review'}</button>
        </div>
      )}
      {showFile && (
        <pre style={{ margin: '0 0 10px', maxHeight: 180, overflow: 'auto', padding: 8, fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--text-body)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6 }}>
          {view.file ? JSON.stringify(view.file, null, 2) : 'rules.json is not present.'}
        </pre>
      )}

      <div style={{ ...sectionTitle, color: rejected && !draft ? 'var(--error)' : sectionTitle.color }}>
        {rejected && !draft ? 'IN RULES.JSON · NOT ENFORCED' : draft ? 'EVALUATION ORDER · DRAFT' : 'EVALUATION ORDER'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <RuleRow index={0} rule={{ action: 'block', match: {} }} hits={data.totals.blocked.guard} locked editable={false} />
        {d.rules.map((r, i) => {
          const isCutRule = r.id.startsWith(CUT_PREFIX);
          return (
            <RuleRow key={r.id} index={i + 1} rule={r} hits={hits.get(r.id) ?? 0} unsaved={!baseIds.has(r.id)}
              editable={editable && !isCutRule}
              dropTarget={drag.dragId !== null && drag.dragOverId === r.id && drag.dragId !== r.id}
              drag={editable && !isCutRule ? { onDragStart: () => drag.handleDragStart(r.id), onDragOver: () => drag.handleDragOver(r.id), onDragEnd: drag.handleDragEnd } : undefined}
              onDelete={() => edit({ rules: d.rules.filter((x) => x.id !== r.id) })} />
          );
        })}
        {view.readError && <div style={{ fontSize: 10.5, color: 'var(--error)', fontFamily: 'var(--font-mono)' }}>rules.json: {view.readError}</div>}
        {view.invalid && !view.readError && <div style={{ fontSize: 10.5, color: 'var(--error)', fontFamily: 'var(--font-mono)' }}>The gate would refuse this file: {view.invalid}</div>}
      </div>

      {editable && (
        <>
          {adding && (
            <AddRuleForm onCancel={() => setAdding(false)} onAdd={(rule) => {
              const taken = new Set([...d.rules.map((r) => r.id), ...draftIds.current]);
              const id = draftRuleId(Date.now(), taken);
              draftIds.current.add(id);
              edit({ rules: [...d.rules, { id, ...rule }] });
              setAdding(false);
            }} />
          )}
          <div style={{ display: 'flex', gap: 6, margin: '8px 0 12px' }}>
            {!adding && <button type="button" onClick={() => setAdding(true)} style={buttonStyle('plain')}>Add rule</button>}
            {dirty && <button type="button" disabled={savingOp !== null} onClick={save} style={buttonStyle('primary')}>Save to gate</button>}
            {draft && <button type="button" onClick={() => { setDraft(null); setConflict(false); setAdding(false); }} style={buttonStyle('ghost')}>Discard</button>}
          </div>
        </>
      )}

      <div style={{ ...sectionTitle, marginTop: editable ? 0 : 12 }}>WHEN NOTHING MATCHES</div>
      <div role="radiogroup" aria-label="Default policy" style={{ display: 'flex', border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }}>
        {(['allow', 'block'] as const).map((p, i) => (
          <button key={p} type="button" role="radio" aria-checked={d.default === p} disabled={!editable || cut}
            title={cut ? 'All traffic is cut: restore it first.' : !editable ? disabledReason ?? '' : undefined}
            onClick={() => edit({ default: p })}
            style={{
              flex: 1, height: 26, border: 'none', borderLeft: i ? '1px solid var(--border-strong)' : 'none', fontSize: 11,
              background: d.default === p ? 'var(--bg-selected)' : 'transparent', color: d.default === p ? 'var(--text)' : 'var(--text-muted)',
              fontFamily: 'var(--font-ui)', cursor: editable && !cut ? 'pointer' : 'default',
            }}>
            {p === 'allow' ? 'Allow unless blocked' : 'Block unless allowed'}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        {cut ? (
          <button type="button" disabled={disabledReason !== null} onClick={() => useNetStore.getState().applyRules({ kind: 'restoreAll' })} style={buttonStyle('ok')}>
            <NetIcon name="check" color="var(--net-tunnel)" />Restore all traffic
          </button>
        ) : (
          <button type="button" disabled={disabledReason !== null || dirty} title={dirty ? 'Save or discard your draft first.' : disabledReason ?? undefined}
            onClick={() => setKillOpen(true)} style={buttonStyle('danger')}>
            <NetIcon name="cut" color="#FF8A80" />Cut all traffic now
          </button>
        )}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 4 }}>
        {cut ? 'All traffic is cut. Restoring removes those rules and puts back the previous default.' : 'Blocks by default and ends open connections.'}
      </div>
      {disabledReason && view.write?.state !== 'pending' && (
        <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
          Read-only: {disabledReason} You can still edit <span style={{ fontFamily: 'var(--font-mono)' }}>{view.displayPath}</span>, or use <span style={{ fontFamily: 'var(--font-mono)' }}>glove net block</span>.
        </div>
      )}
      {killOpen && <KillSwitchDialog data={data} onClose={() => setKillOpen(false)} />}
    </div>
  );
}
