import React from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../../lib/types.js';
import { SectionTitle, ToggleRow } from './primitives.js';

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

  return (
    <>
      <SectionTitle><a href="https://github.com/Jigsaw-Studio/styx-godot" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none', borderBottom: 'var(--stroke) solid currentColor' }}>Styx</a></SectionTitle>

      <ToggleRow
        label="Matrix views"
        desc="Show the Matrix tabs: the destinations a session reached, as falling text. A sandboxed (glove) session shows its real connections; any other session shows the hosts its tool calls named. Also serves the same data at /api/styx/v1/matrix for styx-godot. Layman never looks up the hosts it shows."
        checked={styx.enabled}
        // The server deep-merges styx, so sending only the changed field is safe.
        onChange={() => updateConfig({ styx: { ...styx, enabled: !styx.enabled } })}
      />
    </>
  );
}
