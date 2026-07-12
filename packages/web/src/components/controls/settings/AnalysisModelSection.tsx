import React, { useCallback, useEffect, useState } from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { AnalysisProvider, LaymanConfig } from '../../../lib/types.js';
import { PROVIDER_LABELS } from '../../../lib/types.js';
import { SectionTitle, FieldRow, SegmentRow } from './primitives.js';

const PROVIDER_OPTIONS: AnalysisProvider[] = ['anthropic', 'openai', 'openai-compatible', 'litellm'];

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

export function AnalysisModelSection({
  config, onSend,
}: {
  config: LaymanConfig;
  onSend: (msg: ClientMessage) => void;
}) {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const provider = config.analysis.provider;
  const providerCfg = PROVIDER_CONFIG[provider];

  const updateAnalysis = (updates: Partial<LaymanConfig['analysis']>) => {
    onSend({ type: 'config:update', config: { analysis: { ...config.analysis, ...updates } } });
  };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.analysis.provider, config.analysis.endpoint, config.analysis.model]);

  useEffect(() => {
    if (PROVIDER_CONFIG[config.analysis.provider].autoFetchModels) {
      void fetchModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.analysis.provider]);

  const canFetch = !providerCfg.needsEndpoint || !!config.analysis.endpoint;

  return (
    <>
      <SectionTitle>Analysis model</SectionTitle>

      <SegmentRow
        label="Provider"
        options={PROVIDER_OPTIONS.map((p) => ({ label: PROVIDER_LABELS[p], value: p }))}
        value={provider}
        onChange={(p) => {
          updateAnalysis({ provider: p });
          setAvailableModels([]);
          setFetchError(null);
        }}
      />

      {providerCfg.needsEndpoint && (
        <FieldRow
          label="Endpoint URL"
          value={config.analysis.endpoint ?? ''}
          placeholder={providerCfg.endpointPlaceholder}
          onChange={(v) => {
            updateAnalysis({ endpoint: v });
            setAvailableModels([]);
            setFetchError(null);
          }}
        />
      )}

      <FieldRow
        label="API Key"
        type="password"
        value={config.analysis.apiKey ?? ''}
        placeholder={providerCfg.apiKeyPlaceholder}
        onChange={(v) => updateAnalysis({ apiKey: v || undefined })}
      />

      <FieldRow
        label="Model"
        value={config.analysis.model}
        placeholder="Enter model name or fetch models"
        selectOptions={availableModels.length ? availableModels : undefined}
        onChange={(v) => updateAnalysis({ model: v })}
        action={
          <button
            onClick={() => void fetchModels()}
            disabled={!canFetch || fetchingModels}
            style={{
              fontSize: 10.5,
              color: 'var(--accent)',
              background: 'none',
              border: 'none',
              cursor: canFetch && !fetchingModels ? 'pointer' : 'default',
              opacity: !canFetch || fetchingModels ? 0.4 : 1,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {fetchingModels ? 'Fetching…' : '⟳ Fetch models'}
          </button>
        }
      />
      {fetchError && (
        <p style={{ fontSize: 10.5, color: 'var(--error)', margin: 0 }}>{fetchError}</p>
      )}
    </>
  );
}
