import React, { useEffect, useState } from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../../lib/types.js';
import { SectionTitle, ToggleRow, CustomRow } from './primitives.js';

const DEFAULT_SESSIONS_DIR = '~/.glove/envs';
const DEFAULT_NETWORK = { enabled: true, controlEnabled: true, geoipDbPath: '' };

/**
 * glove — passive monitoring of sandboxed harnesses. Enabling it points the
 * existing file watchers at glove's per-environment homes in addition to the
 * native ones; native monitoring is unaffected either way. Read-only: nothing is
 * written into a sandbox. See CLAUDE.md "Type duplication" — mirrors GloveConfigSchema.
 */
export function GloveSection({
  config, onSend,
}: {
  config: LaymanConfig;
  onSend: (msg: ClientMessage) => void;
}) {
  const updateConfig = (updates: Partial<LaymanConfig>) => onSend({ type: 'config:update', config: updates });
  const glove = config.glove ?? { enabled: false, sessionsDir: DEFAULT_SESSIONS_DIR, showIpAddresses: false, network: DEFAULT_NETWORK };
  const network = glove.network ?? DEFAULT_NETWORK;
  // The server deep-merges glove and glove.network, so sending only the changed field is safe.
  const setNetwork = (updates: Partial<typeof network>) => updateConfig({ glove: { ...glove, network: { ...network, ...updates } } });

  return (
    <>
      <SectionTitle><a href="https://github.com/castellotti/glove" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none', borderBottom: '1px solid currentColor' }}>Glove</a></SectionTitle>

      <ToggleRow
        label="Monitor sandboxed sessions"
        desc="Tail harness logs from glove sandboxes alongside native sessions. Read-only; only harnesses that persist a transcript (Mistral Vibe and pi) are discovered. Sandboxed sessions are tagged with their environment id."
        checked={glove.enabled}
        onChange={() => updateConfig({ glove: { ...glove, enabled: !glove.enabled } })}
      />

      <CustomRow>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>Sessions directory</span>
          <input
            type="text"
            value={glove.sessionsDir ?? DEFAULT_SESSIONS_DIR}
            onChange={(e) => updateConfig({ glove: { ...glove, sessionsDir: e.target.value } })}
            spellCheck={false}
            style={{ width: 220, padding: '4px 6px', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 5, color: 'var(--text)', outline: 'none' }}
          />
        </div>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
          Host directory glove persists environment homes under; each is scanned at
          <code style={{ margin: '0 3px', fontFamily: 'var(--font-mono)' }}>&lt;dir&gt;/&lt;env-id&gt;/home/</code>.
          In Docker this must match the mount in docker-compose.yml (default maps to the container's <code style={{ fontFamily: 'var(--font-mono)' }}>~/.glove/envs</code>).
        </span>
      </CustomRow>

      {glove.enabled && (
      <ToggleRow
        label="Network views"
        desc="Show the Network, Map, Topology and Trace tabs for glove sessions that record their traffic. Layman never looks up the hosts it shows: no DNS, no geo-IP service."
        checked={network.enabled}
        onChange={() => setNetwork({ enabled: !network.enabled })}
      />
      )}
      {glove.enabled && network.enabled && (
      <ToggleRow
        label="Allow blocking from Layman"
        desc="Let the network views write the session's rules.json (block, unblock, cut all traffic). Off makes every toggle read-only. In Docker, `make docker-run` adds the writable ~/.glove/control mount once glove has created that folder."
        checked={network.controlEnabled}
        onChange={() => setNetwork({ controlEnabled: !network.controlEnabled })}
      />
      )}
      {glove.enabled && network.enabled && <GeoDatabaseRow path={network.geoipDbPath} onChange={(geoipDbPath) => setNetwork({ geoipDbPath })} />}
      {glove.enabled && (
      <ToggleRow
        label="Show IP addresses in sandboxed sessions"
        desc={config.piiFilter
          ? 'The PII filter redacts IP addresses everywhere. On, it leaves them in glove sessions only, so a fetch of an IP (such as cloud metadata at 169.254.169.254) shows in Logs and joins its connection in Trace. Other sessions stay redacted. Applies to events recorded from now on; recorded ones stay redacted.'
          : 'The PII filter is off, so IP addresses already show everywhere. This setting takes effect when the filter is on.'}
        checked={glove.showIpAddresses ?? false}
        onChange={() => updateConfig({ glove: { ...glove, showIpAddresses: !glove.showIpAddresses } })}
      />
      )}
    </>
  );
}

interface GeoStatus { configured: boolean; loaded: boolean; databaseType: string | null; buildDate: string | null; error: string | null; attribution: string | null; displayPath: string }

/**
 * The Map's offline geolocation database (plan §5.4). Layman ships none and
 * never looks an IP up anywhere: the user downloads DB-IP's free "IP to City
 * Lite" (.mmdb, CC BY 4.0, no account) and points this at it. In Docker the
 * file must be inside a mounted folder; Layman's own data folder is one.
 */
function GeoDatabaseRow({ path, onChange }: { path: string; onChange: (p: string) => void }) {
  const [draft, setDraft] = useState(path);
  const [status, setStatus] = useState<GeoStatus | null>(null);
  useEffect(() => setDraft(path), [path]);
  useEffect(() => {
    let live = true;
    // The server re-reads the setting on its next poll; ask shortly after a change.
    const t = setTimeout(() => {
      fetch('/api/net/geo').then((r) => (r.ok ? r.json() : null)).then((s) => { if (live) setStatus(s); }).catch(() => {});
    }, 1200);
    return () => { live = false; clearTimeout(t); };
  }, [path]);
  const line = !status
    ? 'Checking…'
    : !status.configured
      ? 'No database: destinations appear in “Unknown location”.'
      : status.loaded
        ? `Loaded ${status.databaseType ?? 'database'}${status.buildDate ? ` (${status.buildDate})` : ''}. ${status.attribution ?? ''}`
        : `Not loaded: ${status.error ?? 'unknown error'}.`;
  return (
    <CustomRow>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>Geolocation database</span>
        <input
          type="text"
          value={draft}
          placeholder="~/.local/share/layman/dbip-city-lite.mmdb"
          aria-label="Geolocation database path"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { if (draft !== path) onChange(draft.trim()); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          spellCheck={false}
          style={{ width: 260, padding: '4px 6px', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 5, color: 'var(--text)', outline: 'none' }}
        />
      </div>
      <span style={{ fontSize: 10.5, color: status?.loaded ? 'var(--ok)' : status?.configured ? 'var(--warn)' : 'var(--text-faint)', lineHeight: 1.5 }}>{line}</span>
      <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
        Places destinations on the Map from a file on this machine; no IP is ever sent anywhere. Download the free
        {' '}<a href="https://db-ip.com/db/download/ip-to-city-lite" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--info)' }}>DB-IP “IP to City Lite”</a>{' '}
        (.mmdb) yourself and put it in Layman’s data folder (<code style={{ fontFamily: 'var(--font-mono)' }}>~/.local/share/layman/</code>), which the container can read.
      </span>
    </CustomRow>
  );
}
