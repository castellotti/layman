import React, { useState } from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig, OptionalClientStatus, SetupStatus } from '../../../lib/types.js';
import { StatusPip } from './StatusPip.js';

export function OpenWebUIConfigDialog({
  config,
  owuiStatus,
  onSend,
  onClose,
  onStatusChange,
}: {
  config: LaymanConfig;
  owuiStatus: OptionalClientStatus | undefined;
  onSend: (msg: ClientMessage) => void;
  onClose: () => void;
  onStatusChange: (status: SetupStatus) => void;
}) {
  const [url, setUrl] = useState(config.openWebUiUrl ?? '');
  const [apiKey, setApiKey] = useState(config.openWebUiApiKey ?? '');
  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState<string | null>(null);
  const [installState, setInstallState] = useState<'idle' | 'busy' | 'error' | 'success'>('idle');
  const [installError, setInstallError] = useState<string | null>(null);
  const [uninstallState, setUninstallState] = useState<'idle' | 'busy' | 'error'>('idle');

  const isInstalled = !!(owuiStatus?.hooksInstalled);
  const isUpToDate = !!(owuiStatus?.hooksUpToDate);
  const urlTrimmed = url.trim();

  const handleDetect = async () => {
    setDetecting(true);
    setDetectResult(null);
    try {
      const res = await fetch('/api/setup/openwebui/detect', { method: 'POST' });
      const data = await res.json() as { detected: boolean; url: string | null; version: string | null };
      if (data.detected && data.url) {
        setUrl(data.url);
        setDetectResult(`Detected Open WebUI${data.version ? ` v${data.version}` : ''} at ${data.url}`);
      } else {
        setDetectResult('No Open WebUI instance found on common ports (3000, 8080).');
      }
    } catch {
      setDetectResult('Detection failed — server unreachable.');
    } finally {
      setDetecting(false);
    }
  };

  // Primary action: always saves config; installs/updates when a URL is set and the
  // filter is missing, outdated, or the URL changed (URL change means the callback
  // address baked into the filter needs refreshing). Passes URL + apiKey in the request
  // body so the server doesn't have to wait for the WebSocket config:update round-trip.
  const urlChanged = urlTrimmed !== (config.openWebUiUrl ?? '').trim();
  const handlePrimary = async () => {
    const apiKeyTrimmed = apiKey.trim();
    onSend({ type: 'config:update', config: { openWebUiUrl: urlTrimmed, openWebUiApiKey: apiKeyTrimmed } });

    if (!urlTrimmed || (isInstalled && isUpToDate && !urlChanged)) {
      onClose();
      return;
    }

    setInstallState('busy');
    setInstallError(null);
    try {
      const res = await fetch('/api/setup/openwebui/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlTrimmed, apiKey: apiKeyTrimmed }),
      });
      if (res.ok) {
        onStatusChange(await res.json() as SetupStatus);
        setInstallState('success');
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setInstallError(data.error ?? `HTTP ${res.status}`);
        setInstallState('error');
      }
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
      setInstallState('error');
    }
  };

  const handleUninstall = async () => {
    setUninstallState('busy');
    try {
      const res = await fetch('/api/setup/openwebui/uninstall', { method: 'POST' });
      if (res.ok) {
        onStatusChange(await res.json() as SetupStatus);
        setUninstallState('idle');
        setInstallState('idle');
      } else {
        setUninstallState('error');
      }
    } catch {
      setUninstallState('error');
    }
  };

  function getPrimaryLabel() {
    if (installState === 'busy') return 'Installing…';
    if (!urlTrimmed || (isInstalled && isUpToDate && !urlChanged)) return 'Save';
    if (!isInstalled) return 'Install';
    return 'Update';
  }
  const primaryLabel = getPrimaryLabel();

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: 'var(--bg-raised)', border: '1px solid var(--border-strong)', borderRadius: 8, boxShadow: '0 24px 60px rgba(0,0,0,0.5)', padding: 20, width: 360, margin: '0 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', margin: 0 }}>Open WebUI</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginBottom: 16, lineHeight: 1.5 }}>
          Installs a filter function into Open WebUI that forwards prompts and responses to Layman.
          Leave the API key blank if your instance runs without authentication. Otherwise generate one in Open WebUI under{' '}
          <span style={{ color: 'var(--text-muted)' }}>Admin Panel → Settings → General → Enable API Key</span>, then{' '}
          <span style={{ color: 'var(--text-muted)' }}>Profile → API Keys</span>.
        </p>

        {isInstalled && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}>
            <StatusPip ok={isInstalled} label="filter" />
            {!isUpToDate && <span style={{ fontSize: 10.5, color: 'var(--warn)' }}>update available</span>}
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Open WebUI URL</label>
            <button
              onClick={() => void handleDetect()}
              disabled={detecting}
              style={{ fontSize: 10.5, color: 'var(--accent)', background: 'none', border: 'none', cursor: detecting ? 'default' : 'pointer', opacity: detecting ? 0.4 : 1 }}
            >
              {detecting ? 'Detecting…' : '⟳ Auto-detect'}
            </button>
          </div>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:3000"
            style={{ width: '100%', padding: '6px 10px', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 5, color: 'var(--text)', outline: 'none', boxSizing: 'border-box' }}
          />
          {detectResult && (
            <p style={{ fontSize: 10.5, marginTop: 4, color: detectResult.startsWith('Detected') ? 'var(--ok)' : 'var(--text-faint)' }}>
              {detectResult}
            </p>
          )}
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
            API Key <span style={{ color: 'var(--text-faint)' }}>(leave blank if auth is disabled)</span>
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-… or leave blank"
            style={{ width: '100%', padding: '6px 10px', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 5, color: 'var(--text)', outline: 'none', boxSizing: 'border-box' }}
          />
        </div>

        {installState === 'error' && installError && (
          <p style={{ fontSize: 10.5, color: 'var(--error)', marginBottom: 12 }}>{installError}</p>
        )}
        {installState === 'success' && (
          <p style={{ fontSize: 10.5, color: 'var(--ok)', marginBottom: 12 }}>Filter function installed successfully.</p>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {isInstalled && (
              <button
                onClick={() => void handleUninstall()}
                disabled={uninstallState === 'busy'}
                style={{ padding: '6px 12px', fontSize: 11, borderRadius: 5, background: 'var(--bg-card)', border: '1px solid var(--border-strong)', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                {uninstallState === 'busy' ? '…' : uninstallState === 'error' ? 'Failed' : 'Uninstall'}
              </button>
            )}
          </div>
          <button
            onClick={() => void handlePrimary()}
            disabled={installState === 'busy'}
            style={{ padding: '6px 12px', fontSize: 11, fontWeight: 500, borderRadius: 5, background: 'var(--ok)', color: 'var(--text-on-fill)', border: 'none', cursor: 'pointer' }}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
