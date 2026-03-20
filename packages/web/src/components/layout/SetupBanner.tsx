import { useCallback, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { SetupStatus } from '../../lib/types.js';

export function SetupBanner({ onInstall }: { onInstall: () => void }) {
  const { setupStatus, setupBannerDismissed, dismissSetupBanner } = useSessionStore((s) => ({
    setupStatus: s.setupStatus,
    setupBannerDismissed: s.setupBannerDismissed,
    dismissSetupBanner: s.dismissSetupBanner,
  }));
  const [installing, setInstalling] = useState(false);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    try {
      onInstall();
      // Refetch status after a short delay to confirm
      setTimeout(async () => {
        try {
          const res = await fetch('/api/setup/status');
          if (res.ok) {
            const status = await res.json() as SetupStatus;
            useSessionStore.getState().setSetupStatus(status);
          }
        } catch {
          // Ignore
        }
        setInstalling(false);
      }, 500);
    } catch {
      setInstalling(false);
    }
  }, [onInstall]);

  if (setupBannerDismissed) return null;
  if (!setupStatus) return null;

  const needsInstall = !setupStatus.hooksInstalled || !setupStatus.commandInstalled;
  const needsUpdate = (!setupStatus.hooksUpToDate && setupStatus.hooksInstalled) ||
    (!setupStatus.commandUpToDate && setupStatus.commandInstalled);

  const detectedClientsNeedingInstall = setupStatus.optionalClients?.filter(
    (c) => c.detected && !c.commandInstalled
  ) ?? [];
  const detectedClientsNeedingUpdate = setupStatus.optionalClients?.filter(
    (c) => c.detected && c.commandInstalled && !c.commandUpToDate
  ) ?? [];

  if (!needsInstall && !needsUpdate && !detectedClientsNeedingInstall.length && !detectedClientsNeedingUpdate.length) return null;

  let message: string;
  if (needsInstall) {
    message = 'Layman needs to install hooks and a slash command in ~/.claude to work.';
  } else if (detectedClientsNeedingInstall.length) {
    const names = detectedClientsNeedingInstall.map((c) => c.name).join(', ');
    message = `${names} detected — click Install to add the /layman command.`;
  } else {
    message = 'Layman has an update available for its hooks or slash command.';
  }

  const buttonLabel = installing
    ? 'Installing...'
    : (needsInstall || detectedClientsNeedingInstall.length)
      ? 'Install'
      : 'Update';

  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-[#1c2128] border-b border-[#30363d] text-sm shrink-0">
      <div className="flex items-center gap-2 text-[#d29922]">
        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>{message}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => void handleInstall()}
          disabled={installing}
          className="px-3 py-1 text-xs font-medium rounded bg-[#238636] hover:bg-[#2ea043] text-white disabled:opacity-50 transition-colors"
        >
          {buttonLabel}
        </button>
        <button
          onClick={dismissSetupBanner}
          className="p-1 text-[#8b949e] hover:text-[#e6edf3] transition-colors"
          title="Dismiss"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
