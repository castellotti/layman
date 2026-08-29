import React from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../../lib/types.js';
import { SectionTitle, ToggleRow, CustomRow } from './primitives.js';

const DEFAULT_SESSIONS_DIR = '~/.glove/envs';

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
  const glove = config.glove ?? { enabled: false, sessionsDir: DEFAULT_SESSIONS_DIR };

  return (
    <>
      <SectionTitle>Glove</SectionTitle>

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
    </>
  );
}
