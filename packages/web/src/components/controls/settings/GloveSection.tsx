import React from 'react';
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
  const glove = config.glove ?? { enabled: false, sessionsDir: DEFAULT_SESSIONS_DIR, network: DEFAULT_NETWORK };
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
    </>
  );
}
