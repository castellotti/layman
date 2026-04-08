import { useState, useCallback, useEffect, useMemo } from 'react';
import { PROVIDER_CONFIG } from '../../controls/SettingsDrawer.js';
import { PROVIDER_LABELS } from '../../../lib/types.js';
import type { LaymanConfig, AnalysisProvider } from '../../../lib/types.js';

const PROVIDER_OPTIONS: AnalysisProvider[] = ['anthropic', 'openai', 'openai-compatible', 'litellm'];

interface AnalysisModelStepProps {
  config: LaymanConfig;
  onConfigChange: (updates: Partial<LaymanConfig>) => void;
}

export function AnalysisModelStep({ config, onConfigChange }: AnalysisModelStepProps) {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const provider = config.analysis.provider;
  const providerCfg = PROVIDER_CONFIG[provider];

  const updateAnalysis = useCallback((updates: Partial<LaymanConfig['analysis']>) => {
    onConfigChange({ analysis: { ...config.analysis, ...updates } });
  }, [onConfigChange, config.analysis]);

  const canFetch = !providerCfg.needsEndpoint || !!config.analysis.endpoint;

  const fetchModels = useCallback(async () => {
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
        if (models.length && !models.includes(config.analysis.model)) {
          updateAnalysis({ model: models[0] });
        }
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
      setAvailableModels([]);
    } finally {
      setFetchingModels(false);
    }
  }, [config.analysis.provider, config.analysis.endpoint, config.analysis.model, updateAnalysis]);

  // Auto-fetch models for providers with known endpoints
  useEffect(() => {
    if (PROVIDER_CONFIG[config.analysis.provider].autoFetchModels) {
      void fetchModels();
    }
  }, [config.analysis.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <h2 className="text-base font-semibold text-[#e6edf3] mb-1">Configure your analysis model</h2>
      <p className="text-xs text-[#8b949e] mb-5">
        Layman uses an AI model to assess the risk of each tool call, generate plain-language explanations,
        and detect when an agent drifts from your goals. Choose a provider and model below.
      </p>

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
              onClick={() => void fetchModels()}
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
    </div>
  );
}
