import React from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../../lib/types.js';
import { SectionTitle, SectionIntro, CustomRow } from './primitives.js';
import { RiskLevelPicker, DepthPicker } from './RiskLevelPicker.js';

export function AutoExplainSection({
  config, onSend,
}: {
  config: LaymanConfig;
  onSend: (msg: ClientMessage) => void;
}) {
  const updateConfig = (updates: Partial<LaymanConfig>) => onSend({ type: 'config:update', config: updates });

  return (
    <>
      <SectionTitle>Auto-explain</SectionTitle>
      <SectionIntro>
        Automatically explain tool calls in plain language using the Layman&apos;s Terms prompt.
        When Auto-Analysis is also enabled, explanation runs after analysis completes.
      </SectionIntro>

      <RiskLevelPicker
        label="Explain"
        verb="explain"
        value={config.autoExplain}
        onChange={(v) => updateConfig({ autoExplain: v })}
      />

      {config.autoExplain !== 'none' && (
        <DepthPicker value={config.autoExplainDepth} onChange={(v) => updateConfig({ autoExplainDepth: v })} />
      )}

      <CustomRow>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>Layman&apos;s Terms prompt</span>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
          The instruction given to the LLM when generating plain-language explanations.
        </span>
        <textarea
          value={config.laymansPrompt ?? ''}
          onChange={(e) => updateConfig({ laymansPrompt: e.target.value })}
          rows={3}
          placeholder="Explain what the AI is doing here in absolute layman's terms..."
          style={{
            width: '100%',
            padding: '8px 10px',
            fontSize: 11,
            fontFamily: 'var(--font-ui)',
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
    </>
  );
}
