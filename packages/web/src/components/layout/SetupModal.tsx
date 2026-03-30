import { useCallback, useEffect, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { SetupStatus } from '../../lib/types.js';

interface PendingClient {
  id: string;
  name: string;
  description: string;
}

function getPendingClients(status: SetupStatus): PendingClient[] {
  const pending: PendingClient[] = [];

  const claudeCodeOk = status.hooksInstalled && status.commandInstalled;
  if (!claudeCodeOk && !status.claudeCodeDeclined) {
    pending.push({ id: 'claude-code', name: 'Claude Code', description: 'HTTP hooks and /layman slash command' });
  }

  for (const c of status.optionalClients ?? []) {
    if (c.detected && !c.commandInstalled && !c.declined) {
      pending.push({ id: c.id, name: c.name, description: '/layman command or hook scripts' });
    }
  }

  return pending;
}

export function SetupModal() {
  const { setupStatus, setupModalDismissed, dismissSetupModal, setSetupStatus } = useSessionStore((s) => ({
    setupStatus: s.setupStatus,
    setupModalDismissed: s.setupModalDismissed,
    dismissSetupModal: s.dismissSetupModal,
    setSetupStatus: s.setSetupStatus,
  }));

  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [installState, setInstallState] = useState<'idle' | 'installing' | 'done' | 'error'>('idle');

  // Reset checked state when pending clients change
  const pendingClients = setupStatus ? getPendingClients(setupStatus) : [];

  useEffect(() => {
    setChecked(Object.fromEntries(pendingClients.map((c) => [c.id, false])));
  // Only run when the set of pending client ids changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingClients.map((c) => c.id).join(',')]);

  const handleInstall = useCallback(async () => {
    setInstallState('installing');
    const toInstall = pendingClients.filter((c) => checked[c.id]).map((c) => c.id);
    const toDecline = pendingClients.filter((c) => !checked[c.id]).map((c) => c.id);

    try {
      // Install selected
      if (toInstall.length > 0) {
        const res = await fetch('/api/setup/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clients: toInstall }),
        });
        if (!res.ok) throw new Error('Install failed');
        const status = await res.json() as SetupStatus;
        setSetupStatus(status);
      }

      // Record declined
      if (toDecline.length > 0) {
        await fetch('/api/setup/decline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clients: toDecline }),
        });
        // Refresh status to reflect declined state
        const statusRes = await fetch('/api/setup/status');
        if (statusRes.ok) {
          const status = await statusRes.json() as SetupStatus;
          setSetupStatus(status);
        }
      }

      setInstallState('done');
      dismissSetupModal();
    } catch {
      setInstallState('error');
    }
  }, [pendingClients, checked, dismissSetupModal, setSetupStatus]);

  if (setupModalDismissed) return null;
  if (!setupStatus) return null;
  if (pendingClients.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md mx-4 bg-[#161b22] border border-[#30363d] rounded-lg shadow-2xl">
        <div className="px-6 pt-6 pb-2">
          <h2 className="text-base font-semibold text-[#e6edf3]">Set up AI agent integrations</h2>
          <p className="mt-1 text-xs text-[#8b949e]">
            The following AI agent clients were detected on your system. Select the integrations to install:
          </p>
        </div>

        <div className="px-6 py-3 space-y-3">
          {pendingClients.map((client) => {
            const on = checked[client.id] ?? false;
            return (
              <div key={client.id} className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-sm text-[#e6edf3]">{client.name}</span>
                  <p className="text-[11px] text-[#8b949e]">{client.description}</p>
                </div>
                <div
                  onClick={() => setChecked((prev) => ({ ...prev, [client.id]: !on }))}
                  className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer shrink-0 ${on ? 'bg-[#238636]' : 'bg-[#30363d]'}`}
                >
                  <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
              </div>
            );
          })}
        </div>

        {installState === 'error' && (
          <p className="px-6 text-xs text-[#f85149]">Installation failed. Check server logs and try again from Settings.</p>
        )}

        <div className="flex items-center justify-between px-6 py-4 border-t border-[#21262d]">
          <button
            onClick={dismissSetupModal}
            className="text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors"
          >
            Not now
          </button>
          <button
            onClick={() => void handleInstall()}
            disabled={installState === 'installing'}
            className="px-4 py-1.5 text-xs font-medium rounded bg-[#238636] hover:bg-[#2ea043] text-white disabled:opacity-50 transition-colors"
          >
            {installState === 'installing' ? 'Installing...' : 'Accept'}
          </button>
        </div>
      </div>
    </div>
  );
}
