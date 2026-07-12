import React, { useCallback, useState } from 'react';
import { useSessionStore } from '../../../stores/sessionStore.js';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { SetupStatus } from '../../../lib/types.js';
import { StatusPip } from './StatusPip.js';
import { SectionTitle, SectionIntro, ActionRow } from './primitives.js';
import { SetupWizardManual } from '../../wizard/SetupWizard.js';

function MiniToggle({ checked, onClick }: { checked: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 30, height: 16, borderRadius: 8,
        border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
        background: checked ? 'var(--bg-selected)' : 'var(--bg-card)',
        position: 'relative', cursor: 'pointer', padding: 0, flexShrink: 0, boxSizing: 'border-box',
      }}
    >
      <span style={{
        position: 'absolute', top: 1.5, left: checked ? 15 : 1.5, width: 11, height: 11, borderRadius: '50%',
        background: checked ? 'var(--accent)' : 'var(--text-faint)', transition: 'left 0.15s',
      }} />
    </button>
  );
}

/** Claude Code + optional-client status rows, reused by the Settings drawer and the Setup Wizard. */
export function HarnessSetupSection({ onSend }: { onSend: (msg: ClientMessage) => void }) {
  const { setupStatus, setSetupStatus, config } = useSessionStore((s) => ({
    setupStatus: s.setupStatus,
    setSetupStatus: s.setSetupStatus,
    config: s.config,
  }));
  const [clientState, setClientState] = useState<Record<string, 'idle' | 'busy' | 'error'>>({});

  const handleInstallClient = useCallback(async (id: string) => {
    setClientState((s) => ({ ...s, [id]: 'busy' }));
    try {
      const res = await fetch(`/api/setup/install/${id}`, { method: 'POST' });
      if (res.ok) {
        setSetupStatus(await res.json() as SetupStatus);
        setClientState((s) => ({ ...s, [id]: 'idle' }));
      } else {
        setClientState((s) => ({ ...s, [id]: 'error' }));
      }
    } catch {
      setClientState((s) => ({ ...s, [id]: 'error' }));
    }
  }, [setSetupStatus]);

  const handleUninstallClient = useCallback(async (id: string) => {
    setClientState((s) => ({ ...s, [id]: 'busy' }));
    try {
      const res = await fetch(`/api/setup/uninstall/${id}`, { method: 'POST' });
      if (res.ok) {
        setSetupStatus(await res.json() as SetupStatus);
        setClientState((s) => ({ ...s, [id]: 'idle' }));
      } else {
        setClientState((s) => ({ ...s, [id]: 'error' }));
      }
    } catch {
      setClientState((s) => ({ ...s, [id]: 'error' }));
    }
  }, [setSetupStatus]);

  const claudeCodeOk = !!(setupStatus?.hooksInstalled && setupStatus.commandInstalled);
  const claudeCodeUpToDate = !!(setupStatus?.hooksUpToDate && setupStatus.commandUpToDate && setupStatus.statusLineUpToDate);
  const optionalClients = setupStatus?.optionalClients ?? [];
  const standardClients = optionalClients.filter((c) => c.id !== 'open-webui');
  const claudeState = clientState['claude-code'] ?? 'idle';

  const autoActivateToggle = (id: string) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 24, paddingLeft: 12 }}>
      <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>Auto-activate sessions</span>
      <MiniToggle
        checked={!!config && (config.autoActivateClients ?? []).includes(id)}
        onClick={() => {
          if (!config) return;
          const clients = config.autoActivateClients ?? [];
          const enabled = clients.includes(id);
          const updated = enabled ? clients.filter((c) => c !== id) : [...clients, id];
          onSend({ type: 'config:update', config: { autoActivateClients: updated } });
        }}
      />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Claude Code row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 26 }}>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>Claude Code</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {setupStatus && claudeCodeOk && (
            <>
              <StatusPip ok={!!setupStatus.hooksInstalled} label="hooks" />
              <StatusPip ok={!!setupStatus.commandInstalled} label="/layman" />
            </>
          )}
          {claudeState === 'busy' ? (
            <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>…</span>
          ) : claudeState === 'error' ? (
            <span style={{ fontSize: 10.5, color: 'var(--error)' }}>Failed</span>
          ) : claudeCodeOk ? (
            <>
              {!claudeCodeUpToDate && (
                <button onClick={() => void handleInstallClient('claude-code')} style={pillButtonStyle}>Update</button>
              )}
              <button onClick={() => void handleUninstallClient('claude-code')} style={pillButtonStyleMuted}>Uninstall</button>
            </>
          ) : (
            <button onClick={() => void handleInstallClient('claude-code')} style={pillButtonStyleOk}>Install</button>
          )}
        </div>
      </div>
      {claudeCodeOk && config && autoActivateToggle('claude-code')}

      {/* Other detected harnesses */}
      {standardClients.map((client) => {
        const state = clientState[client.id] ?? 'idle';
        const commandOk = client.commandInstalled && client.commandUpToDate;
        const hooksOk = client.hooksInstalled === undefined || client.hooksUpToDate !== false;
        const fullyOk = commandOk && hooksOk;
        const needsUpdate = client.detected && client.commandInstalled && !fullyOk;
        return (
          <div key={client.id}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 26 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: client.detected ? 'var(--text)' : 'var(--text-faint)' }}>{client.name}</span>
                {!client.detected && <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>(not detected)</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {client.detected && client.commandInstalled && (
                  <>
                    <StatusPip ok={commandOk} label={client.id === 'codex' ? '$layman' : '/layman'} />
                    {client.hooksInstalled !== undefined && <StatusPip ok={!!client.hooksUpToDate} label="hooks" />}
                  </>
                )}
                {state === 'busy' ? (
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>…</span>
                ) : state === 'error' ? (
                  <span style={{ fontSize: 10.5, color: 'var(--error)' }}>Failed</span>
                ) : client.detected && !client.commandInstalled ? (
                  <button onClick={() => void handleInstallClient(client.id)} style={pillButtonStyleOk}>Install</button>
                ) : needsUpdate ? (
                  <button onClick={() => void handleInstallClient(client.id)} style={pillButtonStyle}>Update</button>
                ) : client.detected && fullyOk ? (
                  <button onClick={() => void handleUninstallClient(client.id)} style={pillButtonStyleMuted}>Uninstall</button>
                ) : null}
              </div>
            </div>
            {client.detected && fullyOk && config && autoActivateToggle(client.id)}
          </div>
        );
      })}
    </div>
  );
}

const pillButtonStyle: React.CSSProperties = {
  padding: '2px 8px', fontSize: 10.5, fontWeight: 500, borderRadius: 4,
  background: 'var(--bg-card)', border: '1px solid var(--border-strong)', color: 'var(--text)', cursor: 'pointer',
};
const pillButtonStyleMuted: React.CSSProperties = { ...pillButtonStyle, color: 'var(--text-muted)' };
const pillButtonStyleOk: React.CSSProperties = {
  padding: '2px 8px', fontSize: 10.5, fontWeight: 500, borderRadius: 4,
  background: 'var(--ok)', border: 'none', color: 'var(--text-on-fill)', cursor: 'pointer',
};

/** Full "Harness" rail section: Claude Code + other client rows, plus the manual setup wizard. */
export function HarnessSection({ onSend }: { onSend: (msg: ClientMessage) => void }) {
  const [wizardOpen, setWizardOpen] = useState(false);
  return (
    <>
      <SectionTitle>Harness</SectionTitle>
      <SectionIntro>
        Installs hooks and the <code>/layman</code> slash command for each AI harness detected on
        this machine. After installing a new harness, reinstall so Layman picks it up.
      </SectionIntro>
      <HarnessSetupSection onSend={onSend} />
      <ActionRow label="Setup wizard" hint="step through installation manually" onClick={() => setWizardOpen(true)} />
      {wizardOpen && <SetupWizardManual onSend={onSend} onClose={() => setWizardOpen(false)} />}
    </>
  );
}
