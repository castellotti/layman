import React from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../../lib/types.js';
import { SectionTitle, SectionIntro } from './primitives.js';
import { RiskLevelPicker, DepthPicker } from './RiskLevelPicker.js';

export function AutoAnalysisSection({
  config, onSend,
}: {
  config: LaymanConfig;
  onSend: (msg: ClientMessage) => void;
}) {
  const updateConfig = (updates: Partial<LaymanConfig>) => onSend({ type: 'config:update', config: updates });

  return (
    <>
      <SectionTitle>Auto-analysis</SectionTitle>
      <SectionIntro>
        When to automatically send tool calls to the analysis model for risk classification.
      </SectionIntro>

      <RiskLevelPicker
        label="Analyze"
        verb="analyze"
        value={config.autoAnalyze}
        onChange={(v) => updateConfig({ autoAnalyze: v })}
      />

      {config.autoAnalyze !== 'none' && (
        <DepthPicker value={config.autoAnalyzeDepth} onChange={(v) => updateConfig({ autoAnalyzeDepth: v })} />
      )}
    </>
  );
}
