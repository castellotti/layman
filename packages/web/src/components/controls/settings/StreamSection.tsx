import React from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../../lib/types.js';
import { SectionTitle, ToggleRow, CustomRow } from './primitives.js';

export function StreamSection({
  config, onSend,
}: {
  config: LaymanConfig;
  onSend: (msg: ClientMessage) => void;
}) {
  const updateConfig = (updates: Partial<LaymanConfig>) => onSend({ type: 'config:update', config: updates });

  return (
    <>
      <SectionTitle>Stream behavior</SectionTitle>

      <ToggleRow
        label="Show full command"
        desc="Display the actual command or path inline after each tool name"
        checked={config.showFullCommand}
        onChange={() => updateConfig({ showFullCommand: !config.showFullCommand })}
      />
      <ToggleRow
        label="Switch to newest session"
        desc="In Logs, automatically select a newly connected session"
        checked={config.switchToNewestSession}
        onChange={() => updateConfig({ switchToNewestSession: !config.switchToNewestSession })}
      />
      <ToggleRow
        label="Collapse history"
        desc="Collapse all event entries by default; click to expand"
        checked={config.collapseHistory}
        onChange={() => updateConfig({ collapseHistory: !config.collapseHistory })}
      />
      <ToggleRow
        label="Auto-scroll"
        desc="Automatically scroll to the newest event as they arrive in a live session"
        checked={config.autoScroll}
        onChange={() => updateConfig({ autoScroll: !config.autoScroll })}
      />

      <CustomRow>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>Idle threshold</span>
          <input
            type="number"
            min={1}
            max={60}
            value={config.idleThresholdMinutes ?? 5}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (v >= 1 && v <= 60) updateConfig({ idleThresholdMinutes: v });
            }}
            style={{ width: 48, padding: '4px 6px', fontSize: 11, textAlign: 'center', fontFamily: 'var(--font-mono)', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 5, color: 'var(--text)', outline: 'none' }}
          />
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>min</span>
        </div>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
          Gaps longer than this between an agent response and your next prompt are classified as
          idle time in Session History (not counted as active work).
        </span>
      </CustomRow>
    </>
  );
}
