import React, { useState, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import type { LaymanConfig, AnalysisProvider, SetupStatus, OptionalClientStatus } from '../../lib/types.js';
import { PROVIDER_LABELS } from '../../lib/types.js';

const PROVIDER_OPTIONS: AnalysisProvider[] = ['anthropic', 'openai', 'openai-compatible', 'litellm'];

/** Per-provider configuration for what fields to show and their defaults. */
const PROVIDER_CONFIG: Record<AnalysisProvider, {
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

function ClientSetupSection() {
  const { setupStatus, setSetupStatus } = useSessionStore((s) => ({
    setupStatus: s.setupStatus,
    setSetupStatus: s.setSetupStatus,
  }));
  const [installState, setInstallState] = useState<'idle' | 'installing' | 'done' | 'error'>('idle');

  const handleInstall = useCallback(async () => {
    setInstallState('installing');
    try {
      const res = await fetch('/api/setup/install', { method: 'POST' });
      if (res.ok) {
        const status = await res.json() as SetupStatus;
        setSetupStatus(status);
        setInstallState('done');
      } else {
        setInstallState('error');
      }
    } catch {
      setInstallState('error');
    }
  }, [setSetupStatus]);

  const claudeOk = !!(setupStatus?.hooksInstalled && setupStatus.commandInstalled);
  const optionalClients: OptionalClientStatus[] = setupStatus?.optionalClients ?? [];

  return (
    <div className="space-y-3">
      {/* Claude Code row — always shown, it's the primary client */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-[#e6edf3]">Claude Code</span>
        <div className="flex items-center gap-1.5">
          <StatusPip ok={!!(setupStatus?.hooksInstalled)} label="hooks" />
          <StatusPip ok={!!(setupStatus?.commandInstalled)} label="/layman" />
        </div>
      </div>

      {/* Optional clients — shown with detected/not-detected state */}
      {optionalClients.map((client) => (
        <div key={client.name} className="flex items-center justify-between">
          <span className={`text-xs ${client.detected ? 'text-[#e6edf3]' : 'text-[#484f58]'}`}>
            {client.name}
            {!client.detected && <span className="ml-1 text-[10px]">(not detected)</span>}
          </span>
          {client.detected && (
            <StatusPip ok={client.commandInstalled && client.commandUpToDate} label="/layman" />
          )}
        </div>
      ))}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={() => void handleInstall()}
          disabled={installState === 'installing'}
          className="px-3 py-1.5 text-xs font-medium rounded bg-[#21262d] border border-[#30363d] text-[#e6edf3] hover:bg-[#30363d] disabled:opacity-50 transition-colors"
        >
          {installState === 'installing' ? 'Installing...' : claudeOk ? 'Reinstall' : 'Install'}
        </button>
        {installState === 'done' && <span className="text-[10px] text-[#3fb950]">Done</span>}
        {installState === 'error' && <span className="text-[10px] text-[#f85149]">Failed</span>}
      </div>
    </div>
  );
}

interface SettingsDrawerProps {
  onSend: (msg: ClientMessage) => void;
}

export function SettingsDrawer({ onSend }: SettingsDrawerProps) {
  const { settingsOpen, setSettingsOpen, config } = useSessionStore();

  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

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

          {/* Auto-Analysis */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-1">
              Auto-Analysis
            </h3>
            <p className="text-[10px] text-[#484f58] mb-3">
              When to automatically send tool calls to the analysis model.
            </p>
            <div className="flex gap-2 mb-3">
              {(['all', 'risky', 'none'] as const).map((mode) => (
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
            <div className="text-[10px] text-[#484f58] space-y-1">
              <p><span className="text-[#8b949e]">All</span> — every tool call is analyzed automatically</p>
              <p><span className="text-[#8b949e]">Risky</span> — only bash, writes, network, and other medium/high-risk tools</p>
              <p><span className="text-[#8b949e]">None</span> — manual only; click Quick or Detailed per event</p>
            </div>
          </section>

          <div className="border-t border-[#30363d]" />

          {/* Auto-Approve */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-1">
              Auto-Approve
            </h3>
            <p className="text-[10px] text-[#484f58] mb-3">
              Skip the approval prompt for tool calls that would otherwise require your sign-off.
              Permission requests (where Claude explicitly asks you a question) are always shown.
            </p>
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-xs text-[#e6edf3]">Auto-approve tool calls</span>
              <div
                onClick={() => updateConfig({ autoApprove: !config.autoApprove })}
                className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
                  config.autoApprove ? 'bg-[#238636]' : 'bg-[#30363d]'
                }`}
              >
                <div
                  className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                    config.autoApprove ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </div>
            </label>
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
                    Automatically select a newly connected session in the session selector
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

          {/* Client Setup */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-1">
              Client Setup
            </h3>
            <p className="text-[10px] text-[#484f58] mb-3">
              Installs hooks and the <code className="text-[#8b949e]">/layman</code> slash command
              for each AI client detected on this machine. After installing a new client, click
              Reinstall so Layman picks it up.
            </p>
            <ClientSetupSection />
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
    </div>
  );
}
