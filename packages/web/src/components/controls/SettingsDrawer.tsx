import React, { useState, useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../lib/types.js';

interface SettingsDrawerProps {
  onSend: (msg: ClientMessage) => void;
}

export function SettingsDrawer({ onSend }: SettingsDrawerProps) {
  const { settingsOpen, setSettingsOpen, config } = useSessionStore();

  // ALL hooks must be declared before any conditional return (Rules of Hooks)
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    const endpoint = config?.analysis.endpoint;
    if (!endpoint) return;
    setFetchingModels(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/models?endpoint=${encodeURIComponent(endpoint)}`);
      const data = await res.json() as { models?: string[]; error?: string };
      if (!res.ok || data.error) {
        setFetchError(data.error ?? `HTTP ${res.status}`);
        setAvailableModels([]);
      } else {
        setAvailableModels(data.models ?? []);
        if (data.models?.length && config && !data.models.includes(config.analysis.model)) {
          onSend({ type: 'config:update', config: { analysis: { ...config.analysis, model: data.models[0] } } });
        }
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
      setAvailableModels([]);
    } finally {
      setFetchingModels(false);
    }
  }, [config?.analysis.endpoint, config?.analysis.model]);

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

  const isOpenAI = config.analysis.provider === 'openai-compatible';

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
          {/* Analysis Model */}
          <section>
            <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-3">
              Analysis Model
            </h3>
            <div className="space-y-3">
              {/* Provider toggle */}
              <div>
                <label className="text-xs text-[#8b949e] block mb-1">Provider</label>
                <div className="flex gap-2">
                  {(['anthropic', 'openai-compatible'] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        updateAnalysis({ provider: p });
                        setAvailableModels([]);
                        setFetchError(null);
                      }}
                      className={`flex-1 px-2 py-1.5 text-xs rounded-md border transition-colors ${
                        config.analysis.provider === p
                          ? 'bg-[#1f6feb] border-[#388bfd] text-white'
                          : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#e6edf3]'
                      }`}
                    >
                      {p === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'}
                    </button>
                  ))}
                </div>
              </div>

              {/* OpenAI-compatible: endpoint first, then model discovery */}
              {isOpenAI && (
                <>
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
                      placeholder="http://localhost:8080/v1"
                      className="w-full px-3 py-1.5 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs text-[#8b949e]">Model</label>
                      <button
                        onClick={fetchModels}
                        disabled={!config.analysis.endpoint || fetchingModels}
                        className="text-[10px] text-[#58a6ff] hover:text-[#79c0ff] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {fetchingModels ? 'Fetching...' : '↻ Fetch models'}
                      </button>
                    </div>

                    {availableModels.length > 0 ? (
                      <select
                        value={config.analysis.model}
                        onChange={(e) => updateAnalysis({ model: e.target.value })}
                        className="w-full px-3 py-1.5 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                      >
                        {availableModels.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={config.analysis.model}
                        onChange={(e) => updateAnalysis({ model: e.target.value })}
                        placeholder="Enter model name or click ↻ Fetch models"
                        className="w-full px-3 py-1.5 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
                      />
                    )}

                    {fetchError && (
                      <p className="text-[10px] text-[#f85149] mt-1">{fetchError}</p>
                    )}
                  </div>
                </>
              )}

              {/* Anthropic: model buttons */}
              {!isOpenAI && (
                <div>
                  <label className="text-xs text-[#8b949e] block mb-1">Model</label>
                  <div className="flex gap-2">
                    {(['haiku', 'sonnet', 'opus'] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => updateAnalysis({ model: m })}
                        className={`flex-1 px-2 py-1.5 text-xs rounded-md border capitalize transition-colors ${
                          config.analysis.model === m
                            ? 'bg-[#1f6feb] border-[#388bfd] text-white'
                            : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#e6edf3]'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* API Key */}
              <div>
                <label className="text-xs text-[#8b949e] block mb-1">
                  API Key{isOpenAI && <span className="text-[#484f58]"> (optional for local models)</span>}
                </label>
                <input
                  type="password"
                  value={config.analysis.apiKey ?? ''}
                  onChange={(e) => updateAnalysis({ apiKey: e.target.value || undefined })}
                  placeholder={isOpenAI ? 'Leave blank if not required' : 'Uses ANTHROPIC_API_KEY env var if not set'}
                  className="w-full px-3 py-1.5 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
                />
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
