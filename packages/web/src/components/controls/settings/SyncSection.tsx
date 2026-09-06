import React, { useCallback, useEffect, useState } from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig, PeerDTO, HostStats, SyncStatus } from '../../../lib/types.js';
import { useSessionStore } from '../../../stores/sessionStore.js';
import { formatContentBytes } from '../../../lib/host.js';
import {
  SectionTitle, SectionIntro, FieldRow, InfoRow, SegmentRow, ActionRow, ToggleRow, CustomRow,
} from './primitives.js';

type Role = 'standalone' | 'central' | 'remote';

const STATE_COLOR: Record<SyncStatus['state'], string> = {
  idle: 'var(--ok)',
  syncing: 'var(--info)',
  backfill: 'var(--info)',
  backoff: 'var(--warn)',
  error: 'var(--error)',
  paused: 'var(--error)',
};

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Settings → Connection → Multi-host sync (docs/planning/multi-host-sync.md §8.3).
 * Mirrors SyncConfigSchema on the server; role/credentials go through
 * `config:update`, and peers/hosts use the local `/api/sync/*` management routes.
 * Mirror (pull) controls arrive in Phase 4.
 */
export function SyncSection({
  config, onSend,
}: {
  config: LaymanConfig;
  onSend: (msg: ClientMessage) => void;
}) {
  const sync = config.sync;
  const syncStatus = useSessionStore((s) => s.syncStatus);
  const syncHosts = useSessionStore((s) => s.syncHosts);
  const update = (updates: Partial<LaymanConfig['sync']>) =>
    onSend({ type: 'config:update', config: { sync: { ...sync, ...updates } } });

  const recordingOff = !config.sessionRecording;

  return (
    <>
      <SectionTitle>Multi-host sync</SectionTitle>

      {recordingOff && (
        <SectionIntro>
          Sync reads from the recorded database, so it needs session recording. Turn on
          <strong> Recording &amp; import → Session recording</strong> first.
        </SectionIntro>
      )}

      {/* ── This host ──────────────────────────────────────────────────────── */}
      <FieldRow
        label="Host name"
        value={sync.hostName}
        onChange={(v) => update({ hostName: v })}
        placeholder="this machine"
      />
      <InfoRow
        label="Host id"
        value={sync.hostId ? sync.hostId.slice(0, 12) + '…' : '(pending)'}
        action={
          sync.hostId ? (
            <button
              onClick={() => void navigator.clipboard?.writeText(sync.hostId)}
              style={{ fontSize: 10, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              title="Copy full host id"
            >
              copy
            </button>
          ) : undefined
        }
      />
      <SegmentRow<Role>
        label="Role"
        desc={recordingOff ? 'Enable session recording to change the role.' : undefined}
        options={[
          { label: 'Standalone', value: 'standalone' },
          { label: 'Central', value: 'central' },
          { label: 'Remote', value: 'remote' },
        ]}
        value={sync.role}
        onChange={(role) => { if (!recordingOff) update({ role }); }}
      />

      {sync.role === 'remote' && <RemotePanel sync={sync} update={update} status={syncStatus} onSend={onSend} config={config} />}
      {sync.role === 'central' && <CentralPanel hosts={syncHosts} />}

      {(sync.role !== 'standalone' || syncHosts.length > 1) && <HostsPanel hosts={syncHosts} />}
    </>
  );
}

// ── Remote (push) ──────────────────────────────────────────────────────────
function RemotePanel({
  sync, update, status, onSend, config,
}: {
  sync: LaymanConfig['sync'];
  update: (u: Partial<LaymanConfig['sync']>) => void;
  status: SyncStatus | null;
  onSend: (msg: ClientMessage) => void;
  config: LaymanConfig;
}) {
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await jsonFetch<{ ok: boolean; centralHostName?: string; error?: string }>('/api/sync/test', { method: 'POST' });
      setTestResult(r.ok ? `Connected to ${r.centralHostName}` : `Failed: ${r.error}`);
    } catch (e) {
      setTestResult(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const dot = status ? STATE_COLOR[status.state] : 'var(--text-faint)';
  const statusLabel = status
    ? status.state === 'backfill'
      ? `Backfilling${status.backfillKind ? ` ${status.backfillKind}` : ''}…`
      : status.state === 'idle' && status.backlog === 0
        ? 'Up to date'
        : status.state === 'idle'
          ? `${status.backlog} change${status.backlog === 1 ? '' : 's'} pending`
          : status.state
    : '—';

  return (
    <>
      <FieldRow label="Central URL" value={sync.centralUrl} onChange={(v) => update({ centralUrl: v })} placeholder="http://central:8880" />
      <FieldRow label="Token" type="password" value={sync.token} onChange={(v) => update({ token: v })} placeholder="lmk_…" />
      <ActionRow label={testing ? 'Testing…' : 'Test connection'} onClick={() => void test()} disabled={testing} hint={testResult ?? undefined} />

      <InfoRow label="Status" value={statusLabel} dotColor={dot} />
      {status?.lastError && <InfoRow label="Last error" value={status.lastError.slice(0, 60)} />}

      <FieldRow
        label="Interval (s)"
        type="number"
        value={String(sync.intervalSeconds)}
        onChange={(v) => { const n = parseInt(v, 10); if (n >= 2 && n <= 300) update({ intervalSeconds: n }); }}
      />

      <ActionRow label="Sync now" onClick={() => void fetch('/api/sync/now', { method: 'POST' })} />

      {/* Mirror: pull the rest of central's history to this host (§3.10). */}
      <ToggleRow
        label="Mirror central history to this host"
        desc="Download every other host's sessions and search them offline. Read-only here."
        checked={sync.mirror}
        onChange={() => update({ mirror: !sync.mirror })}
      />
      {sync.mirror && status?.pull && (
        <InfoRow
          label="Mirror"
          dotColor={STATE_COLOR[status.pull.state === 'incremental' || status.pull.state === 'snapshot' ? 'syncing' : status.pull.state === 'idle' ? 'idle' : status.pull.state]}
          value={
            status.pull.state === 'snapshot'
              ? `Downloading snapshot${status.pull.snapshotKind ? ` (${status.pull.snapshotKind})` : ''}…`
              : status.pull.state === 'idle'
                ? 'Up to date'
                : status.pull.state
          }
        />
      )}
      {sync.mirror && (
        <FieldRow
          label="Mirror interval (s)"
          type="number"
          value={String(sync.mirrorIntervalSeconds)}
          onChange={(v) => { const n = parseInt(v, 10); if (n >= 15 && n <= 3600) update({ mirrorIntervalSeconds: n }); }}
        />
      )}

      <SectionIntro>Danger zone</SectionIntro>
      <ActionRow
        label="Re-send everything"
        variant="danger"
        hint="Clears push cursors → full backfill on next tick"
        onClick={() => { if (confirm('Re-send all local data to central?')) void fetch('/api/sync/reset-push', { method: 'POST' }); }}
      />
      {sync.mirror && (
        <ActionRow
          label="Re-download mirror"
          variant="danger"
          hint="Clears pull cursors → full snapshot on next tick"
          onClick={() => { if (confirm('Re-download all mirrored data from central?')) void fetch('/api/sync/reset-pull', { method: 'POST' }); }}
        />
      )}
      <ActionRow
        label="Forget suppressions"
        variant="danger"
        hint="Lets the origin resurrect sessions you deleted locally"
        onClick={() => { if (confirm('Forget deletion suppressions?')) void fetch('/api/sync/suppressions', { method: 'DELETE' }); }}
      />
    </>
  );
}

// ── Central (peers) ─────────────────────────────────────────────────────────
function CentralPanel({ hosts }: { hosts: HostStats[] }) {
  const [peers, setPeers] = useState<PeerDTO[]>([]);
  const [newName, setNewName] = useState('');
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setPeers(await jsonFetch<PeerDTO[]>('/api/sync/peers')); } catch { /* ignore */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const addPeer = async () => {
    const name = newName.trim();
    if (!name) return;
    const r = await jsonFetch<{ token: string }>('/api/sync/peers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    setIssuedToken(r.token);
    setNewName('');
    void load();
  };

  const revoke = async (hash: string) => { await fetch(`/api/sync/peers/${hash}/revoke`, { method: 'POST' }); void load(); };
  const remove = async (hash: string) => { await fetch(`/api/sync/peers/${hash}`, { method: 'DELETE' }); void load(); };

  const hostFor = (id: string | null) => hosts.find((h) => h.hostId === id);

  return (
    <>
      <SectionIntro>
        <strong>Remote hosts connect to this port.</strong> The compose file binds 127.0.0.1 by
        default — bind it to your LAN or Tailscale address only, never a public interface. The
        dashboard itself has no authentication.
      </SectionIntro>

      {peers.length > 0 && (
        <CustomRow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
            {peers.map((p) => {
              const h = hostFor(p.hostId);
              const online = p.lastSeenAt && Date.now() - p.lastSeenAt < (p.intervalSeconds ?? 5) * 3000;
              const color = p.revokedAt ? 'var(--error)' : online ? 'var(--ok)' : 'var(--text-faint)';
              return (
                <div key={p.tokenHash} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <span style={{ flex: 1, color: 'var(--text)' }}>{p.name}</span>
                  <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                    {h ? `${h.sessionCount} sess · ${formatContentBytes(h.contentBytes)}` : 'not connected'}
                  </span>
                  {!p.revokedAt && (
                    <button onClick={() => void revoke(p.tokenHash)} style={pillBtn('var(--warn)')}>Revoke</button>
                  )}
                  <button onClick={() => void remove(p.tokenHash)} style={pillBtn('var(--error)')}>Remove</button>
                </div>
              );
            })}
          </div>
        </CustomRow>
      )}

      <CustomRow>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New remote host name"
            style={{ flex: 1, padding: '5px 10px', fontSize: 11, background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 5, color: 'var(--text)', outline: 'none' }}
          />
          <button onClick={() => void addPeer()} style={pillBtn('var(--info)')}>Add remote host</button>
        </div>
      </CustomRow>

      {issuedToken && (
        <CustomRow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
            <span style={{ fontSize: 10.5, color: 'var(--warn)' }}>
              Copy this token now — it is shown only once. On the remote: Settings → Multi-host sync →
              role Remote → paste this URL and token → Test connection.
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <code style={{ flex: 1, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text)', background: 'var(--bg-card)', padding: '4px 8px', borderRadius: 4, overflow: 'hidden', textOverflow: 'ellipsis' }}>{issuedToken}</code>
              <button onClick={() => void navigator.clipboard?.writeText(issuedToken)} style={pillBtn('var(--info)')}>Copy</button>
              <button onClick={() => setIssuedToken(null)} style={pillBtn('var(--text-muted)')}>Done</button>
            </div>
          </div>
        </CustomRow>
      )}
    </>
  );
}

// ── Hosts stats table ────────────────────────────────────────────────────────
function HostsPanel({ hosts }: { hosts: HostStats[] }) {
  const recompute = () => void fetch('/api/sync/hosts/recompute', { method: 'POST' });
  const totalSessions = hosts.reduce((n, h) => n + h.sessionCount, 0);
  const totalBytes = hosts.reduce((n, h) => n + h.contentBytes, 0);

  return (
    <>
      <SectionIntro>Hosts</SectionIntro>
      <CustomRow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%', fontSize: 11 }}>
          {hosts.map((h) => (
            <div key={h.hostId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, color: 'var(--text)' }}>
                {h.name}{h.kind === 'local' ? ' (this host)' : ''}
              </span>
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                {h.sessionCount} sess · {h.eventCount} ev · {formatContentBytes(h.contentBytes)}
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 4, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
            <span style={{ flex: 1 }}>Total</span>
            <span>{totalSessions} sess · {formatContentBytes(totalBytes)}</span>
          </div>
        </div>
      </CustomRow>
      <ActionRow label="Recompute" onClick={recompute} hint="Rebuild counters from the database" />
    </>
  );
}

function pillBtn(color: string): React.CSSProperties {
  return {
    padding: '2px 8px', fontSize: 10, color, background: 'transparent',
    border: `1px solid ${color}`, borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
  };
}
