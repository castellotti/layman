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

  // Only show for updates — new installs are handled by SetupModal
  const needsUpdate = (!setupStatus.hooksUpToDate && setupStatus.hooksInstalled) ||
    (!setupStatus.commandUpToDate && setupStatus.commandInstalled);

  const detectedClientsNeedingUpdate = setupStatus.optionalClients?.filter(
    (c) => c.detected && c.commandInstalled && (
      !c.commandUpToDate || (c.hooksInstalled && !c.hooksUpToDate)
    )
  ) ?? [];

  if (!needsUpdate && !detectedClientsNeedingUpdate.length) return null;

  const message = 'Layman has an update available for its hooks or slash command.';

  const buttonLabel = installing ? 'Installing...' : 'Update';

  return (
    <div
      data-print-hide
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px',
        background: 'rgba(229,168,59,0.08)',
        borderBottom: '1px solid rgba(229,168,59,0.2)',
        fontSize: 12,
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--warn)' }}>
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span style={{ fontFamily: 'var(--font-ui)' }}>{message}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => void handleInstall()}
          disabled={installing}
          style={{ padding: '3px 10px', fontSize: 11, fontFamily: 'var(--font-ui)', fontWeight: 500, borderRadius: 5, background: 'var(--ok)', color: '#0B0E14', border: 'none', cursor: 'pointer', opacity: installing ? 0.5 : 1 }}
        >
          {buttonLabel}
        </button>
        <button
          onClick={dismissSetupBanner}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, fontSize: 14, lineHeight: 1 }}
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
