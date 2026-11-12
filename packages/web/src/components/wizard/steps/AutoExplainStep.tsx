import type { LaymanConfig } from '../../../lib/types.js';

interface AutoExplainStepProps {
  config: LaymanConfig;
  onConfigChange: (updates: Partial<LaymanConfig>) => void;
}

export function AutoExplainStep({ config, onConfigChange }: AutoExplainStepProps) {
  return (
    <div>
      <h2 className="text-base font-semibold text-text mb-1">Automatic explanations</h2>
      <p className="text-xs text-text-muted mb-5">
        Auto-Explain translates what each AI tool call does into plain language, so you can understand
        agent activity without reading code. Choose which risk levels trigger automatic explanations,
        or leave this on None to explain events manually.
      </p>

      <div className="flex gap-2 mb-3">
        {(['all', 'medium', 'high', 'none'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => onConfigChange({ autoExplain: mode })}
            className={`flex-1 px-2 py-1.5 text-xs rounded-md border capitalize transition-colors ${
              config.autoExplain === mode
                ? 'bg-info border-info text-text-on-fill'
                : 'bg-bg-pill border-border-strong text-text-muted hover:text-text'
            }`}
          >
            {mode}
          </button>
        ))}
      </div>
      <div className="text-[10px] text-text-faint space-y-1 mb-3">
        <p><span className="text-text-muted">All</span> — explain every tool call automatically</p>
        <p><span className="text-text-muted">Medium</span> — explain medium and high-risk tool calls</p>
        <p><span className="text-text-muted">High</span> — explain only high-risk tool calls</p>
        <p><span className="text-text-muted">None</span> — manual only; click Quick or Detailed per event</p>
      </div>
      {config.autoExplain !== 'none' && (
        <div>
          <p className="text-[10px] text-text-faint mb-2">Explanation depth</p>
          <div className="flex gap-2">
            {(['quick', 'detailed'] as const).map((depth) => (
              <button
                key={depth}
                onClick={() => onConfigChange({ autoExplainDepth: depth })}
                className={`flex-1 px-2 py-1.5 text-xs rounded-md border capitalize transition-colors ${
                  config.autoExplainDepth === depth
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
