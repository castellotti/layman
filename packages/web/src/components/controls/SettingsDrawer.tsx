import React, { useState, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { SetupWizardManual } from '../wizard/SetupWizard.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import type { LaymanConfig, AnalysisProvider, SetupStatus, OptionalClientStatus } from '../../lib/types.js';
import { PROVIDER_LABELS } from '../../lib/types.js';

const PROVIDER_OPTIONS: AnalysisProvider[] = ['anthropic', 'openai', 'openai-compatible', 'litellm'];

interface PiiCategory {
  id: string;
  label: string;
  description: string;
  group: 'direct' | 'indirect' | 'special';
  detected: boolean;
}

const PII_CATEGORIES: PiiCategory[] = [
  { id: 'email', label: 'Email addresses', description: 'Business or personal email addresses', group: 'direct', detected: true },
  { id: 'phone', label: 'Phone numbers', description: 'Telephone numbers in international or local formats', group: 'direct', detected: true },
  { id: 'ipv4', label: 'IPv4 addresses', description: 'Internet Protocol version 4 addresses', group: 'direct', detected: true },
  { id: 'ipv6', label: 'IPv6 addresses', description: 'Internet Protocol version 6 addresses', group: 'direct', detected: true },
  { id: 'mac', label: 'MAC addresses', description: 'Hardware/network interface identifiers', group: 'direct', detected: true },
  { id: 'ssn', label: 'Social security / tax numbers', description: 'National identification, social security, or tax ID numbers', group: 'direct', detected: true },
  { id: 'credit_card', label: 'Credit card numbers', description: 'Payment card numbers (Visa, Mastercard, Amex, etc.)', group: 'direct', detected: true },
  { id: 'iban', label: 'Bank account / IBAN numbers', description: 'International Bank Account Numbers and similar identifiers', group: 'direct', detected: true },
  { id: 'passport', label: 'Passport numbers', description: 'Government-issued passport document numbers', group: 'direct', detected: true },
  { id: 'drivers_license', label: "Driver's license numbers", description: "Driver's license or permit identifiers", group: 'direct', detected: true },
  { id: 'api_key', label: 'API keys', description: 'Provider API keys including Anthropic (sk-ant-) and OpenAI (sk-) formats', group: 'direct', detected: true },
  { id: 'access_token', label: 'Access tokens', description: 'GitHub tokens (ghp_, github_pat_, gho_, ghu_, ghs_, ghr_) and other bearer tokens', group: 'direct', detected: true },
  { id: 'device_id', label: 'Device identifiers', description: 'Apple iOS UDIDs, IDFAs, Android device IDs, and advertising IDs', group: 'direct', detected: true },
  { id: 'secret', label: 'Passwords / secrets / private keys', description: 'Credentials, passwords, private keys, and JWTs', group: 'direct', detected: true },
  { id: 'name', label: 'Personal names', description: 'First name, last name, full name of natural persons', group: 'indirect', detected: false },
  { id: 'postal_address', label: 'Postal addresses', description: 'Street addresses, ZIP/postal codes, city, country', group: 'indirect', detected: false },
  { id: 'user_id', label: 'User / customer / supplier IDs', description: 'System-specific identifiers that map to a natural person', group: 'indirect', detected: false },
  { id: 'biometric', label: 'Biometric data', description: 'Fingerprints, facial recognition data, voice prints', group: 'indirect', detected: false },
  { id: 'geolocation', label: 'Geo-location data', description: 'GPS coordinates or location tracking information', group: 'indirect', detected: false },
  { id: 'dob', label: 'Date of birth', description: 'Birth date that can contribute to identification', group: 'indirect', detected: false },
  { id: 'racial_ethnic', label: 'Racial or ethnic origin', description: 'Data revealing racial or ethnic background', group: 'special', detected: false },
  { id: 'political', label: 'Political opinions', description: 'Political party membership or beliefs', group: 'special', detected: false },
  { id: 'religious', label: 'Religious or philosophical beliefs', description: 'Faith, religious membership, or philosophical convictions', group: 'special', detected: false },
  { id: 'trade_union', label: 'Trade-union membership', description: 'Membership in trade unions or labor organizations', group: 'special', detected: false },
  { id: 'health', label: 'Health / medical data', description: 'Medical records, health conditions, prescriptions', group: 'special', detected: false },
  { id: 'sexual_orientation', label: 'Sexual orientation', description: 'Data concerning sex life or sexual orientation', group: 'special', detected: false },
  { id: 'criminal', label: 'Criminal records', description: 'Criminal proceedings, convictions, or involvement', group: 'special', detected: false },
];

const PII_GROUP_LABELS: Record<string, string> = {
  direct: 'Direct Identifiers (auto-detected)',
  indirect: 'Indirect Identifiers (reference)',
  special: 'Special Categories (reference)',
};

/** Per-provider configuration for what fields to show and their defaults. */
export const PROVIDER_CONFIG: Record<AnalysisProvider, {
  needsEndpoint: boolean;
  endpointPlaceholder: string;
  apiKeyPlaceholder: string;
  apiKeyOptional: boolean;
  autoFetchModels: boolean;
}> = {
  anthropic: {
    needsEndpoint: false,
    endpointPlaceholder: '',
    apiKeyPlaceholder: 'Uses ANTHROPIC_API_KEY env var if not set',
    apiKeyOptional: false,
    autoFetchModels: true,
  },
  openai: {
    needsEndpoint: false,
    endpointPlaceholder: '',
    apiKeyPlaceholder: 'Uses OPENAI_API_KEY env var if not set',
    apiKeyOptional: false,
    autoFetchModels: true,
  },
  'openai-compatible': {
    needsEndpoint: true,
    endpointPlaceholder: 'http://localhost:8080/v1',
    apiKeyPlaceholder: 'Leave blank if not required',
    apiKeyOptional: true,
    autoFetchModels: false,
  },
  litellm: {
    needsEndpoint: true,
    endpointPlaceholder: 'http://localhost:4000/v1',
    apiKeyPlaceholder: 'API key from your LiteLLM proxy',
    apiKeyOptional: false,
    autoFetchModels: false,
  },
};

function StatusPip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${ok ? 'bg-[#1a3a22] text-[#3fb950]' : 'bg-[#3a1a1a] text-[#f85149]'}`}>
      {label}
    </span>
  );
}

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
  const optionalClients: OptionalClientStatus[] = setupStatus?.optionalClients ?? [];

  const claudeState = clientState['claude-code'] ?? 'idle';

  return (
    <div className="space-y-2">
      {/* Claude Code row */}
      <div className="flex items-center justify-between min-h-[28px]">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#e6edf3]">Claude Code</span>
        </div>
        <div className="flex items-center gap-1.5">
          {setupStatus && claudeCodeOk && (
            <>
              <StatusPip ok={!!(setupStatus.hooksInstalled)} label="hooks" />
              <StatusPip ok={!!(setupStatus.commandInstalled)} label="/layman" />
            </>
          )}
          {claudeState === 'busy' ? (
            <span className="text-[10px] text-[#8b949e]">...</span>
          ) : claudeState === 'error' ? (
            <span className="text-[10px] text-[#f85149]">Failed</span>
          ) : claudeCodeOk ? (
            <>
              {!claudeCodeUpToDate && (
                <button
                  onClick={() => void handleInstallClient('claude-code')}
                  className="px-2 py-0.5 text-[10px] font-medium rounded bg-[#21262d] border border-[#30363d] text-[#e6edf3] hover:bg-[#30363d] transition-colors"
                >
                  Update
                </button>
              )}
              <button
                onClick={() => void handleUninstallClient('claude-code')}
                className="px-2 py-0.5 text-[10px] font-medium rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:bg-[#30363d] hover:text-[#f85149] transition-colors"
              >
                Uninstall
              </button>
            </>
          ) : (
            <button
              onClick={() => void handleInstallClient('claude-code')}
              className="px-2 py-0.5 text-[10px] font-medium rounded bg-[#238636] text-white hover:bg-[#2ea043] transition-colors"
            >
              Install
            </button>
          )}
        </div>
      </div>

      {/* Auto-activate toggle — shown when Claude Code is installed */}
      {claudeCodeOk && config && (
        <div className="flex items-center justify-between min-h-[28px] pl-3">
          <span className="text-[11px] text-[#8b949e]">Auto-activate sessions</span>
          <button
            onClick={() => {
              const clients = config.autoActivateClients ?? [];
              const enabled = clients.includes('claude-code');
              const updated = enabled
                ? clients.filter((c: string) => c !== 'claude-code')
                : [...clients, 'claude-code'];
              onSend({ type: 'config:update', config: { autoActivateClients: updated } });
            }}
            className={`relative inline-flex h-4 w-8 items-center rounded-full transition-colors ${
              (config.autoActivateClients ?? []).includes('claude-code') ? 'bg-[#238636]' : 'bg-[#30363d]'
            }`}
          >
            <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
              (config.autoActivateClients ?? []).includes('claude-code') ? 'translate-x-4' : 'translate-x-0.5'
            }`} />
          </button>
        </div>
      )}

      {/* Optional clients */}
      {optionalClients.map((client) => {
        const state = clientState[client.id] ?? 'idle';
        const commandOk = client.commandInstalled && client.commandUpToDate;
        const hooksOk = client.hooksInstalled === undefined || client.hooksUpToDate !== false;
        const fullyOk = commandOk && hooksOk;
        const needsUpdate = client.detected && client.commandInstalled && !fullyOk;
        const showAutoActivate = client.id === 'codex' && client.detected && fullyOk && config;
        return (
          <div key={client.id}>
            <div className="flex items-center justify-between min-h-[28px]">
              <div className="flex items-center gap-2">
                <span className={`text-xs ${client.detected ? 'text-[#e6edf3]' : 'text-[#484f58]'}`}>
                  {client.name}
                </span>
                {!client.detected && (
                  <span className="text-[10px] text-[#484f58]">(not detected)</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {client.detected && client.commandInstalled && (
                  <>
                    <StatusPip ok={commandOk} label={client.id === 'codex' ? '$layman' : '/layman'} />
                    {client.hooksInstalled !== undefined && (
                      <StatusPip ok={!!client.hooksUpToDate} label="hooks" />
                    )}
                  </>
                )}
                {state === 'busy' ? (
                  <span className="text-[10px] text-[#8b949e]">...</span>
                ) : state === 'error' ? (
                  <span className="text-[10px] text-[#f85149]">Failed</span>
                ) : client.detected && !client.commandInstalled ? (
                  <button
                    onClick={() => void handleInstallClient(client.id)}
                    className="px-2 py-0.5 text-[10px] font-medium rounded bg-[#238636] text-white hover:bg-[#2ea043] transition-colors"
                  >
                    Install
                  </button>
                ) : needsUpdate ? (
                  <button
                    onClick={() => void handleInstallClient(client.id)}
                    className="px-2 py-0.5 text-[10px] font-medium rounded bg-[#21262d] border border-[#30363d] text-[#e6edf3] hover:bg-[#30363d] transition-colors"
                  >
                    Update
                  </button>
                ) : client.detected && fullyOk ? (
                  <button
                    onClick={() => void handleUninstallClient(client.id)}
                    className="px-2 py-0.5 text-[10px] font-medium rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:bg-[#30363d] hover:text-[#f85149] transition-colors"
                  >
                    Uninstall
                  </button>
                ) : null}
              </div>
            </div>
            {showAutoActivate && (
              <div className="flex items-center justify-between min-h-[28px] pl-3">
                <span className="text-[11px] text-[#8b949e]">Auto-activate sessions</span>
                <button
                  onClick={() => {
                    const clients = config.autoActivateClients ?? [];
                    const enabled = clients.includes('codex');
                    const updated = enabled
                      ? clients.filter((c: string) => c !== 'codex')
                      : [...clients, 'codex'];
                    onSend({ type: 'config:update', config: { autoActivateClients: updated } });
                  }}
                  className={`relative inline-flex h-4 w-8 items-center rounded-full transition-colors ${
                    (config.autoActivateClients ?? []).includes('codex') ? 'bg-[#238636]' : 'bg-[#30363d]'
                  }`}
                >
                  <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
                    (config.autoActivateClients ?? []).includes('codex') ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface SettingsDrawerProps {
  onSend: (msg: ClientMessage) => void;
}

export function SettingsDrawer({ onSend }: SettingsDrawerProps) {
  const { settingsOpen, setSettingsOpen, config } = useSessionStore();

  const [wizardOpen, setWizardOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [piiCriteriaOpen, setPiiCriteriaOpen] = useState(false);
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [recoveryScanState, setRecoveryScanState] = useState<'idle' | 'scanning' | 'done'>('idle');
  const [recoveryScanCount, setRecoveryScanCount] = useState<number | null>(null);
  const [recoveryScanSessionCount, setRecoveryScanSessionCount] = useState<number | null>(null);
  const [purgeState, setPurgeState] = useState<'idle' | 'scanning' | 'confirming' | 'purging' | 'done' | 'error'>('idle');
  const [scanResult, setScanResult] = useState<{ categories: { name: string; key: string; count: number }[]; total: number } | null>(null);
  const [purgeResult, setPurgeResult] = useState<{ redacted: number } | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  const provider = config?.analysis.provider ?? 'anthropic';
  const providerCfg = PROVIDER_CONFIG[provider];

  const fetchModels = useCallback(async () => {
    if (!config) return;
    const p = config.analysis.provider;
    const cfg = PROVIDER_CONFIG[p];
    if (cfg.needsEndpoint && !config.analysis.endpoint) return;

    setFetchingModels(true);
    setFetchError(null);
    try {
      const params = new URLSearchParams({ provider: p });
      if (config.analysis.endpoint) params.set('endpoint', config.analysis.endpoint);
      const res = await fetch(`/api/models?${params}`);
      const data = await res.json() as { models?: string[]; error?: string };
      if (!res.ok || data.error) {
        setFetchError(data.error ?? `HTTP ${res.status}`);
        setAvailableModels([]);
      } else {
        const models = data.models ?? [];
        setAvailableModels(models);
        if (models.length && config && !models.includes(config.analysis.model)) {
          onSend({ type: 'config:update', config: { analysis: { ...config.analysis, model: models[0] } } });
        }
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
      setAvailableModels([]);
    } finally {
      setFetchingModels(false);
    }
  }, [config?.analysis.provider, config?.analysis.endpoint, config?.analysis.model, onSend]);

  const handlePurgeScan = useCallback(async () => {
    setPurgeState('scanning');
    setPurgeError(null);
    try {
      const res = await fetch('/api/pii-purge/scan', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as { categories: { name: string; key: string; count: number }[]; total: number };
      setScanResult(result);
      if (result.total === 0) {
        setPurgeResult({ redacted: 0 });
        setPurgeState('done');
      } else {
        setPurgeState('confirming');
      }
    } catch (err) {
      setPurgeError(err instanceof Error ? err.message : String(err));
      setPurgeState('error');
    }
  }, []);

  const handlePurgeExecute = useCallback(async () => {
    setPurgeState('purging');
    try {
      const res = await fetch('/api/pii-purge/execute', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as { redacted: number };
      setPurgeResult(result);
      setPurgeState('done');
      // Also clear localStorage search history
      localStorage.removeItem('layman:searchHistory');
    } catch (err) {
      setPurgeError(err instanceof Error ? err.message : String(err));
      setPurgeState('error');
    }
  }, []);

  const handlePurgeClose = useCallback(() => {
    setPurgeState('idle');
    setScanResult(null);
    setPurgeResult(null);
    setPurgeError(null);
  }, []);

  // Auto-fetch models for providers with known endpoints
  useEffect(() => {
    if (!config) return;
    if (PROVIDER_CONFIG[config.analysis.provider].autoFetchModels) {
      void fetchModels();
    }
  }, [config?.analysis.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!settingsOpen || !config) return null;

  const updateConfig = (updates: Partial<LaymanConfig>) => {
    onSend({ type: 'config:update', config: updates });
  };

  const updateAnalysis = (updates: Partial<LaymanConfig['analysis']>) => {
    updateConfig({ analysis: { ...config.analysis, ...updates } });
  };

  const updateAutoAllow = (updates: Partial<LaymanConfig['autoAllow']>) => {
    updateConfig({ autoAllow: { ...config.autoAllow, ...updates } });
  };

  const canFetch = !providerCfg.needsEndpoint || !!config.analysis.endpoint;

  return (
    <>
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="fixed inset-0 bg-black/50"
        onClick={() => setSettingsOpen(false)}
      />
      <div className="relative w-96 bg-[#161b22] border-l border-[#30363d] h-full overflow-y-auto shadow-2xl">
        <div className="sticky top-0 flex items-center justify-between px-4 py-3 bg-[#161b22] border-b border-[#30363d] z-10">
          <h2 className="text-sm font-semibold text-[#e6edf3]">Settings</h2>
          <button
            onClick={() => setSettingsOpen(false)}
            className="text-[#8b949e] hover:text-[#e6edf3] transition-colors text-lg"
          >
            ×
          </button>
        </div>

        <div className="p-4 space-y-6">
          {/* Setup Wizard launcher */}
          <button
            onClick={() => setWizardOpen(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-md bg-[#21262d] border border-[#30363d] text-[#e6edf3] hover:bg-[#30363d] hover:border-[#484f58] transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-[#58a6ff]"><path d="M8.186 1.113a.5.5 0 0 0-.372 0L1.846 3.5l5.84 2.737a.5.5 0 0 0 .428 0l5.84-2.737-5.768-2.387zM15 4.239l-6.5 3.046a1.5 1.5 0 0 1-1.284-.016L1 4.239V11.5a.5.5 0 0 0 .276.447l6.5 3.25a.5.5 0 0 0 .448 0l6.5-3.25A.5.5 0 0 0 15 11.5V4.239z"/></svg>
            Setup Wizard
          </button>

          <div className="border-t border-[#30363d]" />

          {/* Session Recording */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-1">
              Session Recording
            </h3>
            <p className="text-[10px] text-[#484f58] mb-3">
              Record all Claude Code sessions to{' '}
              <code className="text-[#8b949e]">~/.claude/layman.db</code>. Disabled by default.
              Bookmarked sessions survive container restarts.
            </p>
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-xs text-[#e6edf3]">Enable session recording</span>
              <div
                onClick={() => updateConfig({ sessionRecording: !config.sessionRecording })}
                className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
                  config.sessionRecording ? 'bg-[#238636]' : 'bg-[#30363d]'
                }`}
              >
                <div
                  className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                    config.sessionRecording ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </div>
            </label>

            <div className="mt-3">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs text-[#e6edf3]">Enable recording recovery</span>
                <div
                  onClick={() => {
                    if (!config.recordingRecovery) {
                      setRecoveryDialogOpen(true);
                    } else {
                      updateConfig({ recordingRecovery: false });
                    }
                  }}
                  className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
                    config.recordingRecovery ? 'bg-[#238636]' : 'bg-[#30363d]'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                      config.recordingRecovery ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </div>
              </label>
              <p className="text-[10px] text-[#484f58] mt-1">
                On startup, scan recent session transcripts for events missing from the record (e.g. written while Layman was stopped) and fill the gaps.
              </p>
            </div>

            <div className="mt-3">
              <label className="flex items-center justify-between cursor-pointer">
                <button
                  type="button"
                  onClick={() => setPiiCriteriaOpen(!piiCriteriaOpen)}
                  className="text-xs text-[#e6edf3] hover:text-[#58a6ff] transition-colors flex items-center gap-1"
                >
                  <span className={`inline-block transition-transform text-[10px] ${piiCriteriaOpen ? 'rotate-90' : ''}`}>
                    &#9656;
                  </span>
                  PII filter
                </button>
                <div
                  onClick={() => updateConfig({ piiFilter: !config.piiFilter })}
                  className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
                    config.piiFilter ? 'bg-[#238636]' : 'bg-[#30363d]'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                      config.piiFilter ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </div>
              </label>
              <p className="text-[10px] text-[#484f58] mt-1">
                Redact personally identifiable information from logged events.
                Click the label to see what is filtered.
              </p>

              {piiCriteriaOpen && (
                <div className="mt-2 p-2 bg-[#0d1117] border border-[#30363d] rounded-md max-h-64 overflow-y-auto">
                  {(['direct', 'indirect', 'special'] as const).map((group) => (
                    <div key={group} className="mb-2 last:mb-0">
                      <h4 className="text-[10px] font-semibold text-[#8b949e] uppercase tracking-wider mb-1">
                        {PII_GROUP_LABELS[group]}
                      </h4>
                      <ul className="space-y-0.5">
                        {PII_CATEGORIES.filter((c) => c.group === group).map((cat) => (
                          <li key={cat.id} className="flex items-start gap-1.5 text-[10px]">
                            <span className={`mt-0.5 shrink-0 ${cat.detected ? 'text-[#3fb950]' : 'text-[#484f58]'}`}>
                              {cat.detected ? '\u25cf' : '\u25cb'}
                            </span>
                            <span className="text-[#e6edf3]">
                              {cat.label}
                              <span className="text-[#484f58] ml-1">— {cat.description}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  <p className="text-[10px] text-[#484f58] mt-2 border-t border-[#30363d] pt-2">
                    <span className="text-[#3fb950]">{'\u25cf'}</span> Auto-detected via pattern matching{' '}
                    <span className="text-[#484f58] ml-2">{'\u25cb'}</span> Listed for awareness
                  </p>
                </div>
              )}
            </div>

            <div className="mt-3 pt-3 border-t border-[#30363d]/50 flex items-start justify-between">
              <p className="text-[10px] text-[#484f58] mt-1">
                Scan stored sessions and bookmarks for PII and redact all matches.
              </p>
              <button
                onClick={() => void handlePurgeScan()}
                disabled={purgeState === 'scanning' || purgeState === 'purging'}
                className="px-3 py-1.5 text-xs font-medium rounded bg-[#da3633]/20 border border-[#f85149]/30 text-[#f85149] hover:bg-[#da3633]/30 disabled:opacity-50 transition-colors shrink-0 ml-3"
              >
                {purgeState === 'scanning' ? 'Scanning...' : 'Purge all PII'}
              </button>
            </div>
          </section>

          <div className="border-t border-[#30363d]" />

          {/* Analysis Model */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-3">
              Analysis Model
            </h3>
            <div className="space-y-3">
              {/* Provider */}
              <div>
                <label className="text-xs text-[#8b949e] block mb-1">Provider</label>
                <select
                  value={provider}
                  onChange={(e) => {
                    updateAnalysis({ provider: e.target.value as AnalysisProvider });
                    setAvailableModels([]);
                    setFetchError(null);
                  }}
                  className="w-full px-3 py-1.5 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                >
                  {PROVIDER_OPTIONS.map((p) => (
                    <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                  ))}
                </select>
              </div>

              {/* Endpoint URL */}
              {providerCfg.needsEndpoint && (
                <div>
                  <label className="text-xs text-[#8b949e] block mb-1">Endpoint URL</label>
                  <input
                    type="text"
                    value={config.analysis.endpoint ?? ''}
                    onChange={(e) => {
                      updateAnalysis({ endpoint: e.target.value });
                      setAvailableModels([]);
                      setFetchError(null);
                    }}
                    placeholder={providerCfg.endpointPlaceholder}
                    className="w-full px-3 py-1.5 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
                  />
                </div>
              )}

              {/* API Key */}
              <div>
                <label className="text-xs text-[#8b949e] block mb-1">
                  API Key
                  {providerCfg.apiKeyOptional && (
                    <span className="text-[#484f58]"> (optional for local models)</span>
                  )}
                </label>
                <input
                  type="password"
                  value={config.analysis.apiKey ?? ''}
                  onChange={(e) => updateAnalysis({ apiKey: e.target.value || undefined })}
                  placeholder={providerCfg.apiKeyPlaceholder}
                  className="w-full px-3 py-1.5 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
                />
              </div>

              {/* Model */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-[#8b949e]">Model</label>
                  <button
                    onClick={fetchModels}
                    disabled={!canFetch || fetchingModels}
                    className="text-[10px] text-[#58a6ff] hover:text-[#79c0ff] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {fetchingModels ? 'Fetching...' : '\u21bb Fetch models'}
                  </button>
                </div>

                {availableModels.length > 0 ? (
                  <select
                    value={config.analysis.model}
                    onChange={(e) => updateAnalysis({ model: e.target.value })}
                    className="w-full px-3 py-1.5 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                  >
                    {!availableModels.includes(config.analysis.model) && config.analysis.model && (
                      <option value={config.analysis.model}>{config.analysis.model}</option>
                    )}
                    {availableModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={config.analysis.model}
                    onChange={(e) => updateAnalysis({ model: e.target.value })}
                    placeholder="Enter model name or click \u21bb Fetch models"
                    className="w-full px-3 py-1.5 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
                  />
                )}

                {fetchError && (
                  <p className="text-[10px] text-[#f85149] mt-1">{fetchError}</p>
                )}
              </div>
            </div>
          </section>

          <div className="border-t border-[#30363d]" />

          {/* Auto-Explain */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-1">
              Auto-Explain
            </h3>
            <p className="text-[10px] text-[#484f58] mb-3">
              Automatically explain tool calls in plain language using the Layman&apos;s Terms prompt. When Auto-Analysis is also enabled, explanation runs after analysis completes.
            </p>
            <div className="flex gap-2 mb-3">
              {(['all', 'medium', 'high', 'none'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => updateConfig({ autoExplain: mode })}
                  className={`flex-1 px-2 py-1.5 text-xs rounded-md border capitalize transition-colors ${
                    config.autoExplain === mode
                      ? 'bg-[#1f6feb] border-[#388bfd] text-white'
                      : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#e6edf3]'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
            <div className="text-[10px] text-[#484f58] space-y-1 mb-3">
              <p><span className="text-[#8b949e]">All</span> — explain every tool call automatically</p>
              <p><span className="text-[#8b949e]">Medium</span> — explain medium and high-risk tool calls</p>
              <p><span className="text-[#8b949e]">High</span> — explain only high-risk tool calls</p>
              <p><span className="text-[#8b949e]">None</span> — manual only; click Quick or Detailed per event</p>
            </div>
            {config.autoExplain !== 'none' && (
              <div>
                <p className="text-[10px] text-[#484f58] mb-2">Explanation depth</p>
                <div className="flex gap-2">
                  {(['quick', 'detailed'] as const).map((depth) => (
                    <button
                      key={depth}
                      onClick={() => updateConfig({ autoExplainDepth: depth })}
                      className={`flex-1 px-2 py-1.5 text-xs rounded-md border capitalize transition-colors ${
                        config.autoExplainDepth === depth
                          ? 'bg-[#21262d] border-[#388bfd] text-[#58a6ff]'
                          : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#e6edf3]'
                      }`}
                    >
                      {depth === 'quick' ? '⚡ Quick' : '🔍 Detailed'}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <div className="border-t border-[#30363d]" />

          {/* Auto-Analysis */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-1">
              Auto-Analysis
            </h3>
            <p className="text-[10px] text-[#484f58] mb-3">
              When to automatically send tool calls to the analysis model for risk classification.
            </p>
            <div className="flex gap-2 mb-3">
              {(['all', 'medium', 'high', 'none'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => updateConfig({ autoAnalyze: mode })}
                  className={`flex-1 px-2 py-1.5 text-xs rounded-md border capitalize transition-colors ${
                    config.autoAnalyze === mode
                      ? 'bg-[#1f6feb] border-[#388bfd] text-white'
                      : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#e6edf3]'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
            <div className="text-[10px] text-[#484f58] space-y-1 mb-3">
              <p><span className="text-[#8b949e]">All</span> — analyze every tool call automatically</p>
              <p><span className="text-[#8b949e]">Medium</span> — analyze medium and high-risk tool calls</p>
              <p><span className="text-[#8b949e]">High</span> — analyze only high-risk tool calls</p>
              <p><span className="text-[#8b949e]">None</span> — manual only; click Quick or Detailed per event</p>
            </div>
            {config.autoAnalyze !== 'none' && (
              <div>
                <p className="text-[10px] text-[#484f58] mb-2">Analysis depth</p>
                <div className="flex gap-2">
                  {(['quick', 'detailed'] as const).map((depth) => (
                    <button
                      key={depth}
                      onClick={() => updateConfig({ autoAnalyzeDepth: depth })}
                      className={`flex-1 px-2 py-1.5 text-xs rounded-md border capitalize transition-colors ${
                        config.autoAnalyzeDepth === depth
                          ? 'bg-[#21262d] border-[#388bfd] text-[#58a6ff]'
                          : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#e6edf3]'
                      }`}
                    >
                      {depth === 'quick' ? '⚡ Quick' : '🔍 Detailed'}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <div className="border-t border-[#30363d]" />

          {/* Auto-Approve */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-1">
              Auto-Approve
            </h3>
            <p className="text-[10px] text-[#484f58] mb-3">
              Skip the approval prompt for tool calls below the selected risk threshold.
              Permission requests (where Claude explicitly asks you a question) are always shown.
            </p>
            <div className="flex rounded-md overflow-hidden border border-[#30363d] mb-2">
              {(['all', 'medium', 'low', 'none'] as const).map((level) => {
                const isActive = (config.autoApprove as string) === level;
                const labels: Record<string, string> = { all: 'All', medium: 'Medium', low: 'Low', none: 'None' };
                return (
                  <button
                    key={level}
                    onClick={() => updateConfig({ autoApprove: level })}
                    className={`flex-1 py-1.5 text-xs font-mono transition-colors ${
                      isActive ? 'bg-[#238636] text-white' : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
                    }`}
                  >
                    {labels[level]}
                  </button>
                );
              })}
            </div>
            <div className="text-[10px] text-[#484f58] space-y-1">
              <p><span className="text-[#8b949e]">All</span> — every tool call is auto-approved</p>
              <p><span className="text-[#8b949e]">Medium</span> — low + medium risk auto-approved; high requires sign-off</p>
              <p><span className="text-[#8b949e]">Low</span> — only low-risk tools auto-approved; medium + high require sign-off</p>
              <p><span className="text-[#8b949e]">None</span> — every tool call requires manual approval</p>
            </div>
          </section>

          <div className="border-t border-[#30363d]" />

          {/* Auto-Allow Rules */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-3">
              Auto-Allow Rules
            </h3>
            <div className="space-y-3">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs text-[#e6edf3]">Auto-allow read-only tools</span>
                <div
                  onClick={() => updateAutoAllow({ readOnly: !config.autoAllow.readOnly })}
                  className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
                    config.autoAllow.readOnly ? 'bg-[#238636]' : 'bg-[#30363d]'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                      config.autoAllow.readOnly ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </div>
              </label>
              <p className="text-[10px] text-[#484f58]">
                Read, Glob, Grep, WebSearch → auto-approved without prompting
              </p>

              <div>
                <label className="text-xs text-[#8b949e] block mb-1">
                  Trusted command patterns (one regex per line)
                </label>
                <textarea
                  value={config.autoAllow.trustedCommands.join('\n')}
                  onChange={(e) =>
                    updateAutoAllow({
                      trustedCommands: e.target.value
                        .split('\n')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="^ls\b&#10;^cat\b&#10;^echo\b"
                  rows={4}
                  className="w-full px-3 py-2 text-xs font-mono bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] resize-y"
                />
              </div>
            </div>
          </section>

          <div className="border-t border-[#30363d]" />

          {/* Drift Monitoring */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-1">
              Drift Monitoring
            </h3>
            <p className="text-[10px] text-[#484f58] mb-3">
              Periodically assess whether the AI agent is drifting from original goals or CLAUDE.md rules.
              Uses the configured analysis model.
            </p>
            <div className="space-y-3">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs text-[#e6edf3]">Enable drift monitoring</span>
                <div
                  onClick={() => updateConfig({ driftMonitoring: { ...config.driftMonitoring, enabled: !config.driftMonitoring.enabled } })}
                  className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
                    config.driftMonitoring.enabled ? 'bg-[#238636]' : 'bg-[#30363d]'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                      config.driftMonitoring.enabled ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </div>
              </label>

              {config.driftMonitoring.enabled && (
                <>
                  {/* Check interval */}
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0 mr-3">
                      <span className="text-xs text-[#e6edf3]">Check interval</span>
                      <p className="text-[10px] text-[#484f58] mt-0.5">
                        Run drift check every N tool completions or N minutes, whichever comes first.
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={config.driftMonitoring.checkIntervalToolCalls}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (v >= 1 && v <= 100) updateConfig({ driftMonitoring: { ...config.driftMonitoring, checkIntervalToolCalls: v } });
                        }}
                        className="w-14 px-2 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                      />
                      <span className="text-[10px] text-[#484f58]">tools</span>
                      <input
                        type="number"
                        min={1}
                        max={60}
                        value={config.driftMonitoring.checkIntervalMinutes}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (v >= 1 && v <= 60) updateConfig({ driftMonitoring: { ...config.driftMonitoring, checkIntervalMinutes: v } });
                        }}
                        className="w-14 px-2 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                      />
                      <span className="text-[10px] text-[#484f58]">min</span>
                    </div>
                  </div>

                  {/* Session drift thresholds */}
                  <div>
                    <span className="text-xs text-[#8b949e] block mb-1">Session drift thresholds</span>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px]" style={{ color: '#00e676' }}>Green</span>
                      <input
                        type="number" min={0} max={100}
                        value={config.driftMonitoring.sessionDriftThresholds.green}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (v >= 0 && v <= 100) updateConfig({ driftMonitoring: { ...config.driftMonitoring, sessionDriftThresholds: { ...config.driftMonitoring.sessionDriftThresholds, green: v } } });
                        }}
                        className="w-12 px-1 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                      />
                      <span className="text-[10px]" style={{ color: '#ffb300' }}>Yellow</span>
                      <input
                        type="number" min={0} max={100}
                        value={config.driftMonitoring.sessionDriftThresholds.yellow}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (v >= 0 && v <= 100) updateConfig({ driftMonitoring: { ...config.driftMonitoring, sessionDriftThresholds: { ...config.driftMonitoring.sessionDriftThresholds, yellow: v } } });
                        }}
                        className="w-12 px-1 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                      />
                      <span className="text-[10px]" style={{ color: '#ff9100' }}>Orange</span>
                      <input
                        type="number" min={0} max={100}
                        value={config.driftMonitoring.sessionDriftThresholds.orange}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (v >= 0 && v <= 100) updateConfig({ driftMonitoring: { ...config.driftMonitoring, sessionDriftThresholds: { ...config.driftMonitoring.sessionDriftThresholds, orange: v } } });
                        }}
                        className="w-12 px-1 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                      />
                      <span className="text-[10px]" style={{ color: '#ff3d57' }}>Red</span>
                    </div>
                  </div>

                  {/* Rules drift thresholds */}
                  <div>
                    <span className="text-xs text-[#8b949e] block mb-1">Rules drift thresholds</span>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px]" style={{ color: '#00e676' }}>Green</span>
                      <input
                        type="number" min={0} max={100}
                        value={config.driftMonitoring.rulesDriftThresholds.green}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (v >= 0 && v <= 100) updateConfig({ driftMonitoring: { ...config.driftMonitoring, rulesDriftThresholds: { ...config.driftMonitoring.rulesDriftThresholds, green: v } } });
                        }}
                        className="w-12 px-1 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                      />
                      <span className="text-[10px]" style={{ color: '#ffb300' }}>Yellow</span>
                      <input
                        type="number" min={0} max={100}
                        value={config.driftMonitoring.rulesDriftThresholds.yellow}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (v >= 0 && v <= 100) updateConfig({ driftMonitoring: { ...config.driftMonitoring, rulesDriftThresholds: { ...config.driftMonitoring.rulesDriftThresholds, yellow: v } } });
                        }}
                        className="w-12 px-1 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                      />
                      <span className="text-[10px]" style={{ color: '#ff9100' }}>Orange</span>
                      <input
                        type="number" min={0} max={100}
                        value={config.driftMonitoring.rulesDriftThresholds.orange}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (v >= 0 && v <= 100) updateConfig({ driftMonitoring: { ...config.driftMonitoring, rulesDriftThresholds: { ...config.driftMonitoring.rulesDriftThresholds, orange: v } } });
                        }}
                        className="w-12 px-1 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                      />
                      <span className="text-[10px]" style={{ color: '#ff3d57' }}>Red</span>
                    </div>
                  </div>

                  {/* Threshold ordering warning */}
                  {(config.driftMonitoring.sessionDriftThresholds.green >= config.driftMonitoring.sessionDriftThresholds.yellow
                    || config.driftMonitoring.sessionDriftThresholds.yellow >= config.driftMonitoring.sessionDriftThresholds.orange
                    || config.driftMonitoring.rulesDriftThresholds.green >= config.driftMonitoring.rulesDriftThresholds.yellow
                    || config.driftMonitoring.rulesDriftThresholds.yellow >= config.driftMonitoring.rulesDriftThresholds.orange) && (
                    <p className="text-[10px] text-[#d29922] mt-1">
                      Thresholds should be ordered: Green &lt; Yellow &lt; Orange
                    </p>
                  )}

                  {/* Block on Red */}
                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <span className="text-xs text-[#e6edf3]">Block on red</span>
                      <p className="text-[10px] text-[#484f58] mt-0.5">
                        Halt the agent and require approval when drift reaches red level
                      </p>
                    </div>
                    <div
                      onClick={() => updateConfig({ driftMonitoring: { ...config.driftMonitoring, blockOnRed: !config.driftMonitoring.blockOnRed } })}
                      className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer shrink-0 ml-3 ${
                        config.driftMonitoring.blockOnRed ? 'bg-[#238636]' : 'bg-[#30363d]'
                      }`}
                    >
                      <div
                        className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                          config.driftMonitoring.blockOnRed ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </div>
                  </label>

                  {/* Remind on Orange */}
                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <span className="text-xs text-[#e6edf3]">Remind on orange</span>
                      <p className="text-[10px] text-[#484f58] mt-0.5">
                        Inject a rules summary into tool responses when drift reaches orange
                      </p>
                    </div>
                    <div
                      onClick={() => updateConfig({ driftMonitoring: { ...config.driftMonitoring, remindOnOrange: !config.driftMonitoring.remindOnOrange } })}
                      className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer shrink-0 ml-3 ${
                        config.driftMonitoring.remindOnOrange ? 'bg-[#238636]' : 'bg-[#30363d]'
                      }`}
                    >
                      <div
                        className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                          config.driftMonitoring.remindOnOrange ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </div>
                  </label>
                </>
              )}
            </div>
          </section>

          <div className="border-t border-[#30363d]" />

          {/* User Interface */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-3">
              User Interface
            </h3>
            <div className="space-y-3">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <span className="text-xs text-[#e6edf3]">Show full command</span>
                  <p className="text-[10px] text-[#484f58] mt-0.5">
                    Display the actual command or path inline after each tool name
                  </p>
                </div>
                <div
                  onClick={() => updateConfig({ showFullCommand: !config.showFullCommand })}
                  className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer shrink-0 ml-3 ${
                    config.showFullCommand ? 'bg-[#238636]' : 'bg-[#30363d]'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                      config.showFullCommand ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </div>
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <span className="text-xs text-[#e6edf3]">Switch to newest session</span>
                  <p className="text-[10px] text-[#484f58] mt-0.5">
                    In the Logs view, automatically select a newly connected session in the session selector
                  </p>
                </div>
                <div
                  onClick={() => updateConfig({ switchToNewestSession: !config.switchToNewestSession })}
                  className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer shrink-0 ml-3 ${
                    config.switchToNewestSession ? 'bg-[#238636]' : 'bg-[#30363d]'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                      config.switchToNewestSession ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </div>
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <span className="text-xs text-[#e6edf3]">Collapse history</span>
                  <p className="text-[10px] text-[#484f58] mt-0.5">
                    Collapse all event entries by default. Click an event to expand it.
                  </p>
                </div>
                <div
                  onClick={() => updateConfig({ collapseHistory: !config.collapseHistory })}
                  className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer shrink-0 ml-3 ${
                    config.collapseHistory ? 'bg-[#238636]' : 'bg-[#30363d]'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                      config.collapseHistory ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </div>
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <span className="text-xs text-[#e6edf3]">Auto-scroll</span>
                  <p className="text-[10px] text-[#484f58] mt-0.5">
                    Automatically scroll to the newest event as they arrive during a live session.
                  </p>
                </div>
                <div
                  onClick={() => updateConfig({ autoScroll: !config.autoScroll })}
                  className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer shrink-0 ml-3 ${
                    config.autoScroll ? 'bg-[#238636]' : 'bg-[#30363d]'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                      config.autoScroll ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </div>
              </label>
            </div>
          </section>

          <div className="border-t border-[#30363d]" />

          {/* Session Time Tracking */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-1">
              Session Time Tracking
            </h3>
            <p className="text-[10px] text-[#484f58] mb-3">
              Configure how session time metrics are calculated in Session History.
            </p>
            <div className="space-y-3">
              <div>
                <label className="flex items-center justify-between">
                  <div className="flex-1 min-w-0 mr-3">
                    <span className="text-xs text-[#e6edf3]">Idle threshold</span>
                    <p className="text-[10px] text-[#484f58] mt-0.5">
                      Gaps longer than this between an agent response and your next prompt are classified as idle time (not counted as active work). Lower values are stricter.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={config.idleThresholdMinutes ?? 5}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (v >= 1 && v <= 60) updateConfig({ idleThresholdMinutes: v });
                      }}
                      className="w-14 px-2 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                    />
                    <span className="text-[10px] text-[#484f58]">min</span>
                  </div>
                </label>
              </div>
            </div>
          </section>

          <div className="border-t border-[#30363d]" />

          {/* Layman's Terms Prompt */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-1">
              Layman&apos;s Terms Prompt
            </h3>
            <p className="text-[10px] text-[#484f58] mb-3">
              The instruction given to the LLM when generating plain-language explanations.
            </p>
            <textarea
              value={config.laymansPrompt ?? ''}
              onChange={(e) => updateConfig({ laymansPrompt: e.target.value })}
              rows={3}
              className="w-full px-3 py-2 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] resize-y"
              placeholder="Explain what the AI is doing here in absolute layman's terms..."
            />
          </section>

          <div className="border-t border-[#30363d]" />

          {/* Harness Setup */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-1">
              Harness Setup
            </h3>
            <p className="text-[10px] text-[#484f58] mb-3">
              Installs hooks and the <code className="text-[#8b949e]">/layman</code> slash command
              for each AI harness detected on this machine. After installing a new harness, click
              Reinstall so Layman picks it up.
            </p>
            <HarnessSetupSection onSend={onSend} />
          </section>

          <div className="border-t border-[#30363d]" />

          {/* Hook Settings */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-3">
              Hook Settings
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-[#8b949e] block mb-1">
                  Approval timeout: {config.hookTimeout}s
                </label>
                <input
                  type="range"
                  min="30"
                  max="600"
                  step="30"
                  value={config.hookTimeout}
                  onChange={(e) => updateConfig({ hookTimeout: parseInt(e.target.value, 10) })}
                  className="w-full accent-[#58a6ff]"
                />
                <div className="flex justify-between text-[10px] text-[#484f58] mt-1">
                  <span>30s</span>
                  <span>600s</span>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* PII Purge confirmation dialog */}
      {(purgeState === 'confirming' || purgeState === 'purging' || purgeState === 'done' || purgeState === 'error') && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/60" onClick={purgeState === 'purging' ? undefined : handlePurgeClose} />
          <div className="relative bg-[#161b22] border border-[#30363d] rounded-lg shadow-2xl p-5 max-w-md w-full mx-4">
            {purgeState === 'confirming' && scanResult && (
              <>
                <h3 className="text-sm font-semibold text-[#e6edf3] mb-3">PII Scan Results</h3>
                <p className="text-xs text-[#8b949e] mb-3">
                  Found PII in {scanResult.total} {scanResult.total === 1 ? 'field' : 'fields'} across stored data:
                </p>
                <ul className="space-y-1.5 mb-4">
                  {scanResult.categories.map((cat) => (
                    <li key={cat.key} className="flex justify-between text-xs">
                      <span className="text-[#e6edf3]">{cat.name}</span>
                      <span className={cat.count > 0 ? 'text-[#f85149] font-medium' : 'text-[#484f58]'}>
                        {cat.count} {cat.count === 1 ? 'field' : 'fields'}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-[10px] text-[#f85149] mb-4">
                  This action cannot be undone. All matched PII will be replaced with [REDACTED].
                </p>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={handlePurgeClose}
                    className="px-3 py-1.5 text-xs rounded bg-[#21262d] border border-[#30363d] text-[#e6edf3] hover:bg-[#30363d] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void handlePurgeExecute()}
                    className="px-3 py-1.5 text-xs font-medium rounded bg-[#da3633] text-white hover:bg-[#f85149] transition-colors"
                  >
                    Purge {scanResult.total} {scanResult.total === 1 ? 'field' : 'fields'}
                  </button>
                </div>
              </>
            )}
            {purgeState === 'purging' && (
              <div className="text-center py-4">
                <p className="text-xs text-[#e6edf3]">Purging PII...</p>
                <p className="text-[10px] text-[#484f58] mt-1">Do not close this dialog.</p>
              </div>
            )}
            {purgeState === 'done' && purgeResult && (
              <>
                <h3 className={`text-sm font-semibold mb-2 ${purgeResult.redacted === 0 ? 'text-[#3fb950]' : 'text-[#3fb950]'}`}>
                  {purgeResult.redacted === 0 ? 'No PII Found' : 'Purge Complete'}
                </h3>
                <p className="text-xs text-[#8b949e] mb-4">
                  {purgeResult.redacted === 0
                    ? 'No PII was detected in the database.'
                    : `Redacted ${purgeResult.redacted} ${purgeResult.redacted === 1 ? 'field' : 'fields'}. Search history has also been cleared.`}
                </p>
                <div className="flex justify-end">
                  <button
                    onClick={handlePurgeClose}
                    className="px-3 py-1.5 text-xs rounded bg-[#21262d] border border-[#30363d] text-[#e6edf3] hover:bg-[#30363d] transition-colors"
                  >
                    Close
                  </button>
                </div>
              </>
            )}
            {purgeState === 'error' && (
              <>
                <h3 className="text-sm font-semibold text-[#f85149] mb-2">Error</h3>
                <p className="text-xs text-[#8b949e] mb-4">{purgeError}</p>
                <div className="flex justify-end">
                  <button
                    onClick={handlePurgeClose}
                    className="px-3 py-1.5 text-xs rounded bg-[#21262d] border border-[#30363d] text-[#e6edf3] hover:bg-[#30363d] transition-colors"
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>

      {/* Recording recovery dialog */}
      {recoveryDialogOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div
            className="fixed inset-0 bg-black/60"
            onClick={() => {
              if (recoveryScanState !== 'scanning') setRecoveryDialogOpen(false);
            }}
          />
          <div className="relative w-80 bg-[#161b22] border border-[#30363d] rounded-lg shadow-2xl p-5">
            {recoveryScanState === 'idle' && (
              <>
                <h3 className="text-sm font-semibold text-[#e6edf3] mb-2">Enable recording recovery</h3>
                <p className="text-xs text-[#8b949e] mb-4">
                  Run an update check now? Layman will compare all sessions in history against their
                  available transcript logs and fill any gaps. Subsequent startup scans will be faster
                  since already-checked events will be skipped.
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => {
                      updateConfig({ recordingRecovery: true });
                      setRecoveryDialogOpen(false);
                    }}
                    className="px-3 py-1.5 text-xs rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d] transition-colors"
                  >
                    Not now
                  </button>
                  <button
                    onClick={async () => {
                      updateConfig({ recordingRecovery: true });
                      setRecoveryScanState('scanning');
                      try {
                        const res = await fetch('/api/recovery/scan', { method: 'POST' });
                        const data = await res.json() as { events: number; sessions: number };
                        setRecoveryScanCount(data.events);
                        setRecoveryScanSessionCount(data.sessions);
                      } catch {
                        setRecoveryScanCount(0);
                        setRecoveryScanSessionCount(0);
                      }
                      setRecoveryScanState('done');
                    }}
                    className="px-3 py-1.5 text-xs rounded bg-[#238636] hover:bg-[#2ea043] text-white transition-colors"
                  >
                    Scan now
                  </button>
                </div>
              </>
            )}
            {recoveryScanState === 'scanning' && (
              <div className="flex items-center gap-3 py-1">
                <div className="w-4 h-4 border-2 border-[#58a6ff] border-t-transparent rounded-full animate-spin flex-shrink-0" />
                <p className="text-xs text-[#8b949e]">Scanning session transcripts…</p>
              </div>
            )}
            {recoveryScanState === 'done' && (
              <>
                <h3 className="text-sm font-semibold text-[#e6edf3] mb-2">Scan complete</h3>
                <p className="text-xs text-[#8b949e] mb-4">
                  {recoveryScanCount === 0
                    ? 'No missing events found — all recorded sessions are up to date.'
                    : `Recovered ${recoveryScanCount} missing event${recoveryScanCount === 1 ? '' : 's'} across ${recoveryScanSessionCount} session${recoveryScanSessionCount === 1 ? '' : 's'}.`}
                </p>
                <div className="flex justify-end">
                  <button
                    onClick={() => {
                      setRecoveryDialogOpen(false);
                      setRecoveryScanState('idle');
                      setRecoveryScanCount(null);
                      setRecoveryScanSessionCount(null);
                    }}
                    className="px-3 py-1.5 text-xs rounded bg-[#21262d] border border-[#30363d] text-[#e6edf3] hover:bg-[#30363d] transition-colors"
                  >
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Manual Setup Wizard */}
      {wizardOpen && (
        <SetupWizardManual onSend={onSend} onClose={() => setWizardOpen(false)} />
      )}
    </>
  );
}
