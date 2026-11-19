import React from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../../lib/types.js';
import { SectionTitle, ToggleRow, Code, SubRows } from './primitives.js';
import { PathRow } from './PathRow.js';
import { useMatrixGodotStatus } from '../../../hooks/useMatrixGodotStatus.js';

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
  const tabs = styx.tabs ?? {};
  // The snapshot sent with a non-tab change leaves `tabs` out: the server merges it per key, and a stale copy would undo another switch.
  const { tabs: _tabs, ...flat } = styx;
  const matrixOn = styx.matrix !== false;
  const gibsonOn = styx.gibson !== false;
  // The server deep-merges styx and styx.tabs, so only the changed field need be sent.
  const setTab = (key: keyof NonNullable<typeof styx.tabs>) =>
    updateConfig({ styx: { tabs: { [key]: tabs[key] === false } } } as Partial<LaymanConfig>);
  const { status } = useMatrixGodotStatus(styx.enabled, styx.godotDir);

  return (
    <>
      <SectionTitle><a href="https://github.com/Jigsaw-Studio/styx-godot" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none', borderBottom: 'var(--stroke) solid currentColor' }}>Styx</a></SectionTitle>

      <ToggleRow
        label="Styx"
        desc="The destinations a session reached, drawn as the Matrix and the Gibson. A sandboxed (glove) session shows its real connections; any other session shows the hosts its tool calls named. Also serves the same data at /api/styx/v1 for styx-godot. Layman never looks up the hosts it shows."
        checked={styx.enabled}
        // The type wants the whole block; the server deep-merges, so it cannot blank godotDir.
        onChange={() => updateConfig({ styx: { ...flat, enabled: !styx.enabled } })}
      />

      {styx.enabled && (
        <>
          <ToggleRow
            label="Matrix tabs"
            desc="Falling text: one stream per destination."
            checked={matrixOn}
            onChange={() => updateConfig({ styx: { ...flat, matrix: !matrixOn } })}
          />
          <SubRows
            disabled={!matrixOn}
            items={[
              { id: 'matrix', label: 'Matrix (Godot)', checked: tabs.matrix !== false, onChange: () => setTab('matrix') },
              { id: 'matrix2d', label: 'Matrix 2D', checked: tabs.matrix2d !== false, onChange: () => setTab('matrix2d') },
              { id: 'matrix3d', label: 'Matrix 3D', checked: tabs.matrix3d !== false, onChange: () => setTab('matrix3d') },
            ]}
          />
          <ToggleRow
            label="Gibson tabs"
            desc="A city of towers: one per destination, with traffic between them."
            checked={gibsonOn}
            onChange={() => updateConfig({ styx: { ...flat, gibson: !gibsonOn } })}
          />
          <SubRows
            disabled={!gibsonOn}
            items={[
              { id: 'gibson', label: 'Gibson (Godot)', checked: tabs.gibson !== false, onChange: () => setTab('gibson') },
              { id: 'gibson2d', label: 'Gibson 2D', checked: tabs.gibson2d !== false, onChange: () => setTab('gibson2d') },
              { id: 'gibson3d', label: 'Gibson 3D', checked: tabs.gibson3d !== false, onChange: () => setTab('gibson3d') },
            ]}
          />
        </>
      )}

      {styx.enabled && (
        // Saved on blur or Enter, never per keystroke (PathRow): a half-typed path would be stored and served.
        <PathRow
          label="Godot build folder"
          value={styx.godotDir}
          placeholder={status?.displayDir || '~/.local/share/layman/styx/godot'}
          mode="dir"
          onCommit={(v) => updateConfig({ styx: { ...flat, godotDir: v } })}
        >
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
            A web export of styx-godot made with its &ldquo;Web (Layman)&rdquo; preset (<Code>make styx-godot-build</Code>). Leave empty to use
            Layman&rsquo;s own data folder, which is the only place a Layman running in Docker can see.
          </span>
          {status && (
            <span style={{ fontSize: 10.5, color: status.present ? 'var(--ok)' : 'var(--warn)', lineHeight: 1.5 }}>
              {status.present ? `Build found, made ${status.builtAt ? new Date(status.builtAt).toLocaleString() : 'at an unknown time'}.` : 'No build found.'}
              {status.problems.map((p) => ` ${p}`).join('')}
            </span>
          )}
        </PathRow>
      )}
    </>
  );
}
