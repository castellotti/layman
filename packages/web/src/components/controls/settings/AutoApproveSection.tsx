import React from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../../lib/types.js';
import { SectionTitle, SectionIntro, ToggleRow, CustomRow } from './primitives.js';
import { AutoApproveLevelPicker } from './RiskLevelPicker.js';

export function AutoApproveSection({
  config, onSend,
}: {
  config: LaymanConfig;
  onSend: (msg: ClientMessage) => void;
}) {
  const updateConfig = (updates: Partial<LaymanConfig>) => onSend({ type: 'config:update', config: updates });
  const updateAutoAllow = (updates: Partial<LaymanConfig['autoAllow']>) =>
    updateConfig({ autoAllow: { ...config.autoAllow, ...updates } });

  return (
    <>
      <SectionTitle>Auto-approve</SectionTitle>
      <SectionIntro>
        Skip the approval prompt for tool calls below the selected risk threshold. Permission
        requests (where the agent explicitly asks a question) are always shown.
      </SectionIntro>

      <AutoApproveLevelPicker value={config.autoApprove} onChange={(v) => updateConfig({ autoApprove: v })} />

      <ToggleRow
        label="Auto-allow read-only tools"
        desc="Read, Glob, Grep and WebSearch never wait for approval"
        checked={config.autoAllow.readOnly}
        onChange={() => updateAutoAllow({ readOnly: !config.autoAllow.readOnly })}
      />

      <CustomRow>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>Trusted command patterns</span>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
          One regex per line — matching shell commands are auto-approved.
        </span>
        <textarea
          value={config.autoAllow.trustedCommands.join('\n')}
          onChange={(e) =>
            updateAutoAllow({
              trustedCommands: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
            })
          }
          placeholder={'^ls\\b\n^cat\\b\n^echo\\b'}
          rows={4}
          style={{
            width: '100%',
            padding: '8px 10px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-strong)',
            borderRadius: 5,
            color: 'var(--text)',
            outline: 'none',
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
      </CustomRow>

      <CustomRow>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, color: 'var(--text)' }}>Approval timeout</span>
          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>
            {config.hookTimeout}s
          </span>
        </div>
        <input
          type="range"
          min={30}
          max={600}
          step={30}
          value={config.hookTimeout}
          onChange={(e) => updateConfig({ hookTimeout: parseInt(e.target.value, 10) })}
          style={{ width: '100%', accentColor: 'var(--accent)' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: 'var(--text-faint)' }}>
          <span>30s</span>
          <span>600s</span>
        </div>
      </CustomRow>
    </>
  );
}
