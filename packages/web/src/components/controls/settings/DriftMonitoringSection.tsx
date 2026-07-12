import React from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { DriftThresholds, LaymanConfig } from '../../../lib/types.js';
import { SectionTitle, SectionIntro, ToggleRow, ThresholdRow, CustomRow } from './primitives.js';

function thresholdOutOfOrder(t: DriftThresholds): boolean {
  return t.green >= t.yellow || t.yellow >= t.orange;
}

export function DriftMonitoringSection({
  config, onSend,
}: {
  config: LaymanConfig;
  onSend: (msg: ClientMessage) => void;
}) {
  const drift = config.driftMonitoring;
  const updateDrift = (updates: Partial<LaymanConfig['driftMonitoring']>) =>
    onSend({ type: 'config:update', config: { driftMonitoring: { ...drift, ...updates } } });

  const outOfOrder = thresholdOutOfOrder(drift.sessionDriftThresholds) || thresholdOutOfOrder(drift.rulesDriftThresholds);

  return (
    <>
      <SectionTitle>Drift monitoring</SectionTitle>
      <SectionIntro>
        Periodically assess whether the agent is drifting from original goals or CLAUDE.md /
        AGENTS.md rules. Uses the configured analysis model.
      </SectionIntro>

      <ToggleRow
        label="Enable drift monitoring"
        desc="Scores each session against its goal and rules"
        checked={drift.enabled}
        onChange={() => updateDrift({ enabled: !drift.enabled })}
      />

      {drift.enabled && (
        <>
          <CustomRow>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>Check interval</span>
              <input
                type="number"
                min={1}
                max={100}
                value={drift.checkIntervalToolCalls}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (v >= 1 && v <= 100) updateDrift({ checkIntervalToolCalls: v });
                }}
                style={{ width: 48, padding: '4px 6px', fontSize: 11, textAlign: 'center', fontFamily: 'var(--font-mono)', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 5, color: 'var(--text)', outline: 'none' }}
              />
              <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>tools</span>
              <input
                type="number"
                min={1}
                max={60}
                value={drift.checkIntervalMinutes}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (v >= 1 && v <= 60) updateDrift({ checkIntervalMinutes: v });
                }}
                style={{ width: 48, padding: '4px 6px', fontSize: 11, textAlign: 'center', fontFamily: 'var(--font-mono)', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 5, color: 'var(--text)', outline: 'none' }}
              />
              <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>min</span>
            </div>
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
              Runs every N tool completions or N minutes, whichever comes first.
            </span>
          </CustomRow>

          <ThresholdRow
            label="Session drift thresholds"
            stops={[
              { name: 'green', color: 'var(--ok)', value: drift.sessionDriftThresholds.green, onChange: (v) => updateDrift({ sessionDriftThresholds: { ...drift.sessionDriftThresholds, green: v } }) },
              { name: 'amber', color: 'var(--warn)', value: drift.sessionDriftThresholds.yellow, onChange: (v) => updateDrift({ sessionDriftThresholds: { ...drift.sessionDriftThresholds, yellow: v } }) },
              { name: 'red', color: 'var(--error)', value: drift.sessionDriftThresholds.orange, onChange: (v) => updateDrift({ sessionDriftThresholds: { ...drift.sessionDriftThresholds, orange: v } }) },
            ]}
          />

          <ThresholdRow
            label="Rules drift thresholds"
            stops={[
              { name: 'green', color: 'var(--ok)', value: drift.rulesDriftThresholds.green, onChange: (v) => updateDrift({ rulesDriftThresholds: { ...drift.rulesDriftThresholds, green: v } }) },
              { name: 'amber', color: 'var(--warn)', value: drift.rulesDriftThresholds.yellow, onChange: (v) => updateDrift({ rulesDriftThresholds: { ...drift.rulesDriftThresholds, yellow: v } }) },
              { name: 'red', color: 'var(--error)', value: drift.rulesDriftThresholds.orange, onChange: (v) => updateDrift({ rulesDriftThresholds: { ...drift.rulesDriftThresholds, orange: v } }) },
            ]}
          />

          {outOfOrder && (
            <p style={{ fontSize: 10.5, color: 'var(--warn)', margin: 0 }}>
              Thresholds should be ordered: green &lt; amber &lt; red
            </p>
          )}

          <ToggleRow
            label="Block at red"
            desc="Pause the session when drift crosses the red threshold"
            checked={drift.blockOnRed}
            onChange={() => updateDrift({ blockOnRed: !drift.blockOnRed })}
          />

          <ToggleRow
            label="Remind at amber"
            desc="Inject a goal/rules reminder when drift crosses the amber threshold"
            checked={drift.remindOnOrange}
            onChange={() => updateDrift({ remindOnOrange: !drift.remindOnOrange })}
          />
        </>
      )}
    </>
  );
}
