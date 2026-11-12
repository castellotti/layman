import type { LaymanConfig } from '../../../lib/types.js';

interface AutoAnalysisStepProps {
  config: LaymanConfig;
  onConfigChange: (updates: Partial<LaymanConfig>) => void;
}

export function AutoAnalysisStep({ config, onConfigChange }: AutoAnalysisStepProps) {
  return (
    <div>
      <h2 className="text-base font-semibold text-text mb-1">Automatic risk analysis</h2>
      <p className="text-xs text-text-muted mb-5">
        Auto-Analysis sends each tool call to your analysis model for risk classification (low, medium,
        or high). This powers the risk badges on each event and informs auto-approve decisions.
        Leave on None if you prefer to analyze events manually.
      </p>

      <div className="flex gap-2 mb-3">
        {(['all', 'medium', 'high', 'none'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => onConfigChange({ autoAnalyze: mode })}
            className={`flex-1 px-2 py-1.5 text-xs rounded-md border capitalize transition-colors ${
              config.autoAnalyze === mode
                ? 'bg-info border-info text-text-on-fill'
                : 'bg-bg-pill border-border-strong text-text-muted hover:text-text'
            }`}
          >
            {mode}
          </button>
        ))}
      </div>
      <div className="text-[10px] text-text-faint space-y-1 mb-3">
        <p><span className="text-text-muted">All</span> — analyze every tool call automatically</p>
        <p><span className="text-text-muted">Medium</span> — analyze medium and high-risk tool calls</p>
        <p><span className="text-text-muted">High</span> — analyze only high-risk tool calls</p>
        <p><span className="text-text-muted">None</span> — manual only; click Quick or Detailed per event</p>
      </div>
      {config.autoAnalyze !== 'none' && (
        <div>
          <p className="text-[10px] text-text-faint mb-2">Analysis depth</p>
          <div className="flex gap-2">
            {(['quick', 'detailed'] as const).map((depth) => (
              <button
                key={depth}
                onClick={() => onConfigChange({ autoAnalyzeDepth: depth })}
                className={`flex-1 px-2 py-1.5 text-xs rounded-md border capitalize transition-colors ${
                  config.autoAnalyzeDepth === depth
                    ? 'bg-bg-pill border-info text-info'
                    : 'bg-bg-pill border-border-strong text-text-muted hover:text-text'
                }`}
              >
                {depth === 'quick' ? 'Quick' : 'Detailed'}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
