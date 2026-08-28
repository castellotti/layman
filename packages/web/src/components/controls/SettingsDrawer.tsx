import React, { useMemo, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../lib/types.js';
import { HarnessSection } from './settings/HarnessSection.js';
import { WebUISection } from './settings/WebUISection.js';
import { GloveSection } from './settings/GloveSection.js';
import { AnalysisModelSection } from './settings/AnalysisModelSection.js';
import { AutoExplainSection } from './settings/AutoExplainSection.js';
import { AutoAnalysisSection } from './settings/AutoAnalysisSection.js';
import { AutoApproveSection } from './settings/AutoApproveSection.js';
import { DriftMonitoringSection } from './settings/DriftMonitoringSection.js';
import { RecordingSection } from './settings/RecordingSection.js';
import { StreamSection } from './settings/StreamSection.js';
import { TTSSection } from './settings/TTSSection.js';

export { HarnessSetupSection } from './settings/HarnessSection.js';
export { PROVIDER_CONFIG } from './settings/AnalysisModelSection.js';

type Group = 'Connection' | 'Automation' | 'Data' | 'Stream' | 'Extensions';

interface SectionDef {
  key: string;
  group: Group;
  label: string;
  searchTerms: string[];
  render: (config: LaymanConfig, onSend: (msg: ClientMessage) => void) => React.ReactNode;
}

const SECTIONS: SectionDef[] = [
  {
    key: 'harness', group: 'Connection', label: 'Harness',
    searchTerms: ['Harness', 'Claude Code', 'Codex', 'OpenCode', 'Vibe', 'Cline', 'Auto-activate sessions', 'hooks', 'setup wizard'],
    render: (_config, onSend) => <HarnessSection onSend={onSend} />,
  },
  {
    key: 'webui', group: 'Connection', label: 'Open WebUI',
    searchTerms: ['Open WebUI', 'filter'],
    render: (_config, onSend) => <WebUISection onSend={onSend} />,
  },
  {
    key: 'model', group: 'Automation', label: 'Analysis model',
    searchTerms: ['Provider', 'Endpoint URL', 'API Key', 'Model', 'Fetch models', 'Anthropic', 'OpenAI'],
    render: (config, onSend) => <AnalysisModelSection config={config} onSend={onSend} />,
  },
  {
    key: 'explain', group: 'Automation', label: 'Auto-explain',
    searchTerms: ['Explain', 'Depth', "Layman's Terms prompt"],
    render: (config, onSend) => <AutoExplainSection config={config} onSend={onSend} />,
  },
  {
    key: 'analysis', group: 'Automation', label: 'Auto-analysis',
    searchTerms: ['Analyze', 'Depth'],
    render: (config, onSend) => <AutoAnalysisSection config={config} onSend={onSend} />,
  },
  {
    key: 'approve', group: 'Automation', label: 'Auto-approve',
    searchTerms: ['Auto-approve', 'Auto-allow read-only tools', 'Trusted command patterns', 'Approval timeout'],
    render: (config, onSend) => <AutoApproveSection config={config} onSend={onSend} />,
  },
  {
    key: 'drift', group: 'Automation', label: 'Drift monitoring',
    searchTerms: ['drift', 'thresholds', 'Block at red', 'Remind at amber', 'Check interval'],
    render: (config, onSend) => <DriftMonitoringSection config={config} onSend={onSend} />,
  },
  {
    key: 'recording', group: 'Data', label: 'Recording & import',
    searchTerms: ['recording', 'recovery', 'import', 'PII', 'purge'],
    render: (config, onSend) => <RecordingSection config={config} onSend={onSend} />,
  },
  {
    key: 'tts', group: 'Data', label: 'Text to speech',
    searchTerms: ['speech', 'TTS', 'speaches', 'voice', 'speak', 'audio', 'Kokoro', 'auto-speak', 'pitch', 'playback rate'],
    render: (config, onSend) => <TTSSection config={config} onSend={onSend} />,
  },
  {
    key: 'stream', group: 'Stream', label: 'Stream behavior',
    searchTerms: ['full command', 'newest session', 'collapse history', 'auto-scroll', 'idle threshold'],
    render: (config, onSend) => <StreamSection config={config} onSend={onSend} />,
  },
  {
    key: 'glove', group: 'Extensions', label: 'Glove',
    searchTerms: ['glove', 'sandbox', 'sandboxed', 'container', 'Docker', 'Podman', 'Vibe', 'monitor', 'sessions directory', 'extension', 'plugin'],
    render: (config, onSend) => <GloveSection config={config} onSend={onSend} />,
  },
];

const GROUP_ORDER: Group[] = ['Connection', 'Automation', 'Data', 'Stream', 'Extensions'];

interface SettingsDrawerProps {
  onSend: (msg: ClientMessage) => void;
}

export function SettingsDrawer({ onSend }: SettingsDrawerProps) {
  const { settingsOpen, setSettingsOpen, config } = useSessionStore();
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const visibleSections = useMemo(() => {
    if (!q) return SECTIONS;
    return SECTIONS.filter((s) =>
      s.label.toLowerCase().includes(q) || s.searchTerms.some((t) => t.toLowerCase().includes(q))
    );
  }, [q]);

  const activeSection = visibleSections.find((s) => s.key === activeKey) ?? visibleSections[0];

  if (!settingsOpen || !config) return null;

  const groups = GROUP_ORDER
    .map((name) => ({ name, items: visibleSections.filter((s) => s.group === name) }))
    .filter((g) => g.items.length > 0);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', justifyContent: 'flex-end', fontFamily: 'var(--font-ui)' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(4,6,10,0.6)' }} onClick={() => setSettingsOpen(false)} />
      <div style={{ position: 'relative', width: 740, maxWidth: '92vw', height: '100%', background: 'var(--bg-raised)', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', boxShadow: '-24px 0 60px rgba(0,0,0,0.5)' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Settings</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
            style={{ width: 240, padding: '5px 10px', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 5, color: 'var(--text)', outline: 'none', boxSizing: 'border-box' }}
          />
          <div style={{ flex: 1 }} />
          <button onClick={() => setSettingsOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: 16, cursor: 'pointer', lineHeight: 1, padding: '2px 4px' }}>×</button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Section rail */}
          <div style={{ width: 180, flexShrink: 0, borderRight: '1px solid var(--border)', overflowY: 'auto', padding: '8px 0' }}>
            {groups.map((g) => (
              <div key={g.name} style={{ display: 'flex', flexDirection: 'column', marginBottom: 4 }}>
                <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-faint)', padding: '8px 14px 3px' }}>
                  {g.name}
                </div>
                {g.items.map((s) => {
                  const active = s.key === activeSection?.key;
                  return (
                    <button
                      key={s.key}
                      onClick={() => setActiveKey(s.key)}
                      style={{
                        display: 'flex', alignItems: 'center', textAlign: 'left',
                        padding: '6px 14px 6px 12px', fontSize: 11.5, fontFamily: 'inherit',
                        color: active ? 'var(--text)' : 'var(--text-muted)',
                        background: active ? 'var(--bg-selected)' : 'transparent',
                        border: 'none', borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                        cursor: 'pointer', fontWeight: active ? 600 : 400,
                      }}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            ))}
            {visibleSections.length === 0 && (
              <div style={{ padding: 14, fontSize: 10.5, color: 'var(--text-faint)' }}>No settings match.</div>
            )}
          </div>

          {/* Section content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px 22px', display: 'flex', flexDirection: 'column' }}>
            {activeSection && activeSection.render(config, onSend)}
          </div>
        </div>
      </div>
    </div>
  );
}
