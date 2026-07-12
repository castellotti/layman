import React, { useState } from 'react';
import { useSessionStore } from '../../../stores/sessionStore.js';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import { SectionTitle, SectionIntro } from './primitives.js';
import { StatusPip } from './StatusPip.js';
import { OpenWebUIConfigDialog } from './OpenWebUIDialog.js';

export function WebUISection({ onSend }: { onSend: (msg: ClientMessage) => void }) {
  const { setupStatus, setSetupStatus, config } = useSessionStore((s) => ({
    setupStatus: s.setupStatus,
    setSetupStatus: s.setSetupStatus,
    config: s.config,
  }));
  const [dialogOpen, setDialogOpen] = useState(false);
  const owuiStatus = (setupStatus?.optionalClients ?? []).find((c) => c.id === 'open-webui');

  return (
    <>
      <SectionTitle>Open WebUI</SectionTitle>
      <SectionIntro>
        Installs a filter function into Open WebUI that forwards prompts and responses to Layman.
      </SectionIntro>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 0', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: owuiStatus?.hooksInstalled ? 'var(--text)' : 'var(--text-faint)' }}>Open WebUI</span>
          {owuiStatus?.hooksInstalled && <StatusPip ok={!!owuiStatus.hooksUpToDate} label="filter" />}
        </div>
        <button
          onClick={() => setDialogOpen(true)}
          style={{ padding: '4px 10px', fontSize: 10.5, fontWeight: 500, borderRadius: 5, background: 'var(--bg-card)', border: '1px solid var(--border-strong)', color: 'var(--text)', cursor: 'pointer' }}
        >
          {owuiStatus?.hooksInstalled && !owuiStatus.hooksUpToDate ? 'Update' : 'Configure'}
        </button>
      </div>

      {dialogOpen && config && (
        <OpenWebUIConfigDialog
          config={config}
          owuiStatus={owuiStatus}
          onSend={onSend}
          onClose={() => setDialogOpen(false)}
          onStatusChange={setSetupStatus}
        />
      )}
    </>
  );
}
