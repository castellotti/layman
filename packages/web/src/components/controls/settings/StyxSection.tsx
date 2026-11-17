import React from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../../lib/types.js';
import { SectionTitle, ToggleRow, CustomRow, Code } from './primitives.js';
import { useMatrixGodotStatus } from '../../../hooks/useMatrixGodotStatus.js';
import { sp, rad } from '../../../lib/density.js';

/**
 * Styx: Matrix-style views of the destinations a session reached, and the same
 * data as a feed for styx-godot. Mirrors StyxConfigSchema (CLAUDE.md "Type
 * duplication"). Off by default: with it off there are no tabs.
 */
export function StyxSection({
  config, onSend,
}: {
  config: LaymanConfig;
  onSend: (msg: ClientMessage) => void;
}) {
  const updateConfig = (updates: Partial<LaymanConfig>) => onSend({ type: 'config:update', config: updates });
  // An older server sends no `styx` block.
  const styx = config.styx ?? { enabled: false, godotDir: '' };
  const { status } = useMatrixGodotStatus(styx.enabled, styx.godotDir);

  return (
    <>
      <SectionTitle><a href="https://github.com/Jigsaw-Studio/styx-godot" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none', borderBottom: 'var(--stroke) solid currentColor' }}>Styx</a></SectionTitle>

      <ToggleRow
        label="Matrix views"
        desc="Show the Matrix tabs: the destinations a session reached, as falling text. A sandboxed (glove) session shows its real connections; any other session shows the hosts its tool calls named. Also serves the same data at /api/styx/v1/matrix for styx-godot. Layman never looks up the hosts it shows."
        checked={styx.enabled}
        // The type wants the whole block; the server deep-merges, so it cannot blank godotDir.
        onChange={() => updateConfig({ styx: { ...styx, enabled: !styx.enabled } })}
      />

      {styx.enabled && (
        <CustomRow>
          <div style={{ display: 'flex', alignItems: 'center', gap: sp(12) }}>
            <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>Godot build folder</span>
            <input
              type="text"
              value={styx.godotDir}
              placeholder="~/.local/share/layman/styx/godot"
              onChange={(e) => updateConfig({ styx: { ...styx, godotDir: e.target.value } })}
              spellCheck={false}
              style={{ width: 220, padding: sp('4px 6px'), fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg-card)', border: 'var(--stroke) solid var(--border-strong)', borderRadius: rad(5), color: 'var(--text)', outline: 'none' }}
            />
          </div>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
            A web export of styx-godot made with its &ldquo;Web (Layman)&rdquo; preset (<Code>make styx-godot-build</Code>). Leave empty to use
            Layman&rsquo;s own data folder, which is the only place a Layman running in Docker can see.
          </span>
          {status && (
            <span style={{ fontSize: 10.5, color: status.present && status.problems.length === 0 ? 'var(--ok)' : 'var(--warn)', lineHeight: 1.5 }}>
              {status.present ? `Build found, made ${status.builtAt ? new Date(status.builtAt).toLocaleString() : 'at an unknown time'}.` : 'No build found.'}
              {status.problems.map((p) => ` ${p}`).join('')}
            </span>
          )}
        </CustomRow>
      )}
    </>
  );
}
