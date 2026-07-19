import React from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import { HarnessSection } from './settings/HarnessSection.js';
import { WebUISection } from './settings/WebUISection.js';
import { AnalysisModelSection } from './settings/AnalysisModelSection.js';
import { AutoExplainSection } from './settings/AutoExplainSection.js';
import { AutoAnalysisSection } from './settings/AutoAnalysisSection.js';
import { AutoApproveSection } from './settings/AutoApproveSection.js';
import { DriftMonitoringSection } from './settings/DriftMonitoringSection.js';
import { RecordingSection } from './settings/RecordingSection.js';
import { StreamSection } from './settings/StreamSection.js';

const DOCK_WIDTH = 360;

interface SettingsDockProps {
  onSend: (msg: ClientMessage) => void;
}

/** Static fourth column reusing the same settings sections as SettingsDrawer (§2.9). */
export function SettingsDock({ onSend }: SettingsDockProps) {
  const config = useSessionStore((s) => s.config);
  if (!config) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: DOCK_WIDTH,
        flexShrink: 0,
        overflow: 'hidden',
        background: 'var(--bg-raised)',
        borderLeft: '1px solid var(--border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Settings</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)' }}>docked</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px 22px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <HarnessSection onSend={onSend} />
        <WebUISection onSend={onSend} />
        <AnalysisModelSection config={config} onSend={onSend} />
        <AutoExplainSection config={config} onSend={onSend} />
        <AutoAnalysisSection config={config} onSend={onSend} />
        <AutoApproveSection config={config} onSend={onSend} />
        <DriftMonitoringSection config={config} onSend={onSend} />
        <RecordingSection config={config} onSend={onSend} />
        <StreamSection config={config} onSend={onSend} />
      </div>
    </div>
  );
}
