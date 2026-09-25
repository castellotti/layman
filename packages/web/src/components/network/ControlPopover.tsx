/**
 * What clicking a destination's toggle offers (plan §6.4,
 * controls-block-unblock.dc.html): Block (host, domain or IP; cut open
 * connections; a note; the exact JSON), Unblock a rule of yours (remove it, or
 * allow just this host above it), or Allow a default-blocked destination. A
 * group row writes one rule over the group. Nothing is shown as done until the
 * gate confirms it: the toggle turns `pending` and follows `rules.write`.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNetStore } from '../../stores/netStore.js';
import type { NetSessionData } from '../../lib/net-state.js';
import type { TableRow } from '../../lib/net-table.js';
import { matchText } from '../../lib/net-table.js';
import {
  blockChoices, blockOp, decidedBy, groupTarget, previewText, siblingIds, CUT_PREFIX, type BlockScope,
} from '../../lib/net-rules.js';
import type { DestinationAggregate, Rule, RulesOp } from '../../lib/netobs-types.js';
import { NetIcon } from './netui.js';

const WIDTH = 400;

export const buttonStyle = (kind: 'primary' | 'danger' | 'ok' | 'plain' | 'ghost'): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 26, padding: '0 10px', borderRadius: 6,
  fontSize: 11.5, fontWeight: 500, whiteSpace: 'nowrap', cursor: 'pointer', fontFamily: 'var(--font-ui)',
  ...(kind === 'primary' ? { background: 'var(--text)', border: '1px solid var(--text)', color: 'var(--bg)' }
    : kind === 'danger' ? { background: 'rgba(240,86,74,0.12)', border: '1px solid rgba(240,86,74,0.5)', color: '#FF8A80' }
      : kind === 'ok' ? { background: 'rgba(53,201,180,0.12)', border: '1px solid rgba(53,201,180,0.5)', color: 'var(--net-tunnel)' }
        : kind === 'ghost' ? { background: 'transparent', border: '1px solid transparent', color: 'var(--text-muted)' }
          : { background: 'var(--bg-pill)', border: '1px solid var(--border-strong)', color: 'var(--text)' }),
});

function Choice({ checked, onSelect, label, detail, warning, name }: {
  checked: boolean; onSelect: () => void; label: string; detail: string; warning?: string | null; name: string;
}) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
      border: `1px solid ${checked ? 'var(--info)' : 'var(--border)'}`, background: checked ? 'rgba(90,156,248,0.08)' : 'var(--bg)',
    }}>
      <input type="radio" name={name} checked={checked} onChange={onSelect} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text)' }}>{label}</span>
        <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-faint)' }}>{detail}</span>
        {warning && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--warn)', marginTop: 2 }}>
            <NetIcon name="alert" size={10} color="var(--warn)" />{warning}
          </span>
        )}
      </span>
    </label>
  );
}

function Title({ icon, colour, children }: { icon: 'blocked' | 'check' | 'cut'; colour: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 10 }}>
      <NetIcon name={icon} color={colour} size={13} />{children}
    </div>
  );
}

type Submit = (op: RulesOp) => void;

/** Block an allowed destination, a domain group, or a group by one rule. */
function BlockForm({ row, submit, onClose }: { row: TableRow; submit: Submit; onClose: () => void }) {
  const group = row.kind === 'group' && !row.dest ? groupTarget(row.key, row.label) : null;
  const domainOnly = row.kind === 'group' && !row.dest && !group && row.key.startsWith('domain:');
  const dest: Pick<DestinationAggregate, 'host' | 'groupKey' | 'ips'> = row.dest ?? { host: null, groupKey: row.label, ips: [] };
  const choices = group ? [] : domainOnly ? blockChoices(dest).filter((c) => c.scope === 'domain') : blockChoices(dest);
  const open = (row.dest ? [row.dest] : row.members ?? []).reduce((a, d) => a + d.openFlows, 0);
  const [scope, setScope] = useState<BlockScope>(choices[0]?.scope ?? 'host');
  const [terminate, setTerminate] = useState(open > 0);
  const [note, setNote] = useState('');
  const op: RulesOp | null = group
    ? { kind: 'blockGroup', key: group.key, value: group.value, terminate, note: note.trim() || undefined }
    : choices.length ? blockOp(dest, scope, terminate, note) : null;
  const target = group ? group.label : row.dest?.host ?? row.label;
  return (
    <>
      <Title icon="blocked" colour="var(--error)">Block traffic to {target}</Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {group ? (
          <Choice name="scope" checked onSelect={() => {}} label={`One rule for ${group.label}`} detail={`match { ${group.key}: ${group.value} }`} warning={group.warning} />
        ) : choices.map((c) => (
          <Choice key={c.scope} name="scope" checked={scope === c.scope} onSelect={() => setScope(c.scope)} label={c.label} detail={c.detail} warning={c.warning} />
        ))}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-body)', margin: '10px 0 8px', cursor: 'pointer' }}>
        <input type="checkbox" checked={terminate} onChange={(e) => setTerminate(e.target.checked)} />
        {open > 0 ? `Also cut the ${open} connection${open === 1 ? '' : 's'} that ${open === 1 ? 'is' : 'are'} open now` : 'Also cut connections that are open when the gate reloads'}
      </label>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 4 }}>Note (optional)</div>
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Why you blocked it" aria-label="Note"
        style={{ width: '100%', boxSizing: 'border-box', height: 28, padding: '0 8px', fontSize: 11.5, borderRadius: 6, background: 'var(--bg)', border: '1px solid var(--border-strong)', color: 'var(--text)', outline: 'none', fontFamily: 'var(--font-ui)' }} />
      {op && (
        <pre aria-label="Rule preview" style={{ margin: '8px 0 0', padding: 8, fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, whiteSpace: 'pre-wrap' }}>
          {previewText(op)}
        </pre>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
        <button type="button" onClick={onClose} style={buttonStyle('ghost')}>Cancel</button>
        <button type="button" disabled={!op} onClick={() => op && submit(op)} style={buttonStyle('danger')}>
          <NetIcon name="blocked" color="#FF8A80" />Block
        </button>
      </div>
    </>
  );
}

/** Unblock a destination blocked by the user's own rule. */
function UnblockForm({ row, data, submit, onClose }: { row: TableRow; data: NetSessionData; submit: Submit; onClose: () => void }) {
  const d = row.dest ?? row.members?.[0];
  const ruleId = d?.policy.enforced?.rule ?? d?.rule ?? null;
  const rules: Rule[] = data.rules.enforced?.rules ?? data.rules.file?.rules ?? [];
  const rule = rules.find((r) => r.id === ruleId);
  const pair = ruleId ? siblingIds(ruleId, rules) : [];
  const seen = decidedBy(pair, data.destinations.values()).length;
  const [choice, setChoice] = useState<'remove' | 'allow'>('remove');
  if (!ruleId || !rule) {
    return (
      <>
        <Title icon="blocked" colour="var(--error)">Blocked by a rule that is no longer in rules.json</Title>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>It will unblock once the gate reloads the file.</div>
      </>
    );
  }
  if (rule.id.startsWith(CUT_PREFIX)) {
    return (
      <>
        <Title icon="cut" colour="var(--error)">All traffic is cut</Title>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10 }}>This destination is blocked by “Cut all traffic”. Restoring removes those rules and puts back the previous default.</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button type="button" onClick={onClose} style={buttonStyle('ghost')}>Cancel</button>
          <button type="button" onClick={() => submit({ kind: 'restoreAll' })} style={buttonStyle('ok')}>Restore all traffic</button>
        </div>
      </>
    );
  }
  const host = row.dest?.host ?? null;
  const op: RulesOp = choice === 'allow' && host ? { kind: 'allowHost', host } : { kind: 'removeRule', ids: pair };
  return (
    <>
      <Title icon="blocked" colour="var(--error)">Blocked by your rule{rule.note ? ` “${rule.note}”` : ''}</Title>
      <div style={{ padding: '7px 9px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 8 }}>
        {rule.id} · {rule.action} {matchText(rule)}{rule.terminate ? ' · cuts open' : ''}
        {data.rules.file?.updated_by && <div>last written by {data.rules.file.updated_by}{data.rules.file.updated_at ? ` · ${new Date(data.rules.file.updated_at).toLocaleTimeString()}` : ''}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Choice name="unblock" checked={choice === 'remove'} onSelect={() => setChoice('remove')}
          label={pair.length > 1 ? 'Remove the rule pair' : 'Remove the rule'}
          detail={`unblocks every host it matches (${seen} seen)${pair.length > 1 ? ' · both rules of the domain block' : ''}`} />
        {host && (
          <Choice name="unblock" checked={choice === 'allow'} onSelect={() => setChoice('allow')}
            label={`Allow only ${host}`} detail="adds an allow rule above it" />
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
        <button type="button" onClick={onClose} style={buttonStyle('ghost')}>Cancel</button>
        <button type="button" onClick={() => submit(op)} style={buttonStyle('ok')}><NetIcon name="check" color="var(--net-tunnel)" />Unblock</button>
      </div>
    </>
  );
}

/** A destination nothing allowed: an allow rule would. */
function DefaultForm({ row, submit, onClose }: { row: TableRow; submit: Submit; onClose: () => void }) {
  const d = row.dest;
  const apex = d && d.groupKey.includes('.') && d.groupKey !== d.host ? d.groupKey : null;
  return (
    <>
      <Title icon="blocked" colour="var(--error)">Blocked by the default</Title>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
        No rule allowed it and the session’s default is <b>block</b>. The toggle is outlined, not filled: no rule of yours did this.
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {d?.host && <button type="button" onClick={() => submit({ kind: 'allowHost', host: d.host! })} style={buttonStyle('ok')}><NetIcon name="check" color="var(--net-tunnel)" />Allow {d.host}</button>}
        {apex && <button type="button" onClick={() => submit({ kind: 'allowDomain', apex })} style={buttonStyle('plain')}>Allow {apex}</button>}
        <button type="button" onClick={onClose} style={buttonStyle('ghost')}>Cancel</button>
      </div>
    </>
  );
}

export function ControlPopover({ row, data, anchor, onClose }: {
  row: TableRow;
  data: NetSessionData;
  anchor: DOMRect;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 6 });
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 300;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8));
    const below = anchor.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, anchor.top - h - 6) : below;
    setPos({ left, top });
  }, [anchor]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [onClose]);

  const submit: Submit = (op) => {
    useNetStore.getState().applyRules(op);
    onClose();
  };
  let body: React.ReactNode = null;
  if (row.toggle === 'allow') body = <BlockForm row={row} submit={submit} onClose={onClose} />;
  else if (row.toggle === 'block') body = <UnblockForm row={row} data={data} submit={submit} onClose={onClose} />;
  else if (row.toggle === 'default') body = <DefaultForm row={row} submit={submit} onClose={onClose} />;
  if (!body) return null;
  return (
    <div ref={ref} role="dialog" aria-label={`Rules for ${row.label}`} onClick={(e) => e.stopPropagation()} style={{
      position: 'fixed', left: pos.left, top: pos.top, width: WIDTH, zIndex: 60, padding: 12, borderRadius: 8,
      background: 'var(--bg-card)', border: '1px solid var(--border-strong)', boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
      fontFamily: 'var(--font-ui)',
    }}>
      {body}
    </div>
  );
}
