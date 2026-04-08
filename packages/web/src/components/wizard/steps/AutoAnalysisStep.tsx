import type { LaymanConfig } from '../../../lib/types.js';

interface AutoAnalysisStepProps {
  config: LaymanConfig;
  onConfigChange: (updates: Partial<LaymanConfig>) => void;
}

export function AutoAnalysisStep({ config, onConfigChange }: AutoAnalysisStepProps) {
  return (
    <div>
      <h2 className="text-base font-semibold text-[#e6edf3] mb-1">Automatic risk analysis</h2>
      <p className="text-xs text-[#8b949e] mb-5">
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
                onClick={() => onConfigChange({ autoAnalyzeDepth: depth })}
                className={`flex-1 px-2 py-1.5 text-xs rounded-md border capitalize transition-colors ${
                  config.autoAnalyzeDepth === depth
                    ? 'bg-[#21262d] border-[#388bfd] text-[#58a6ff]'
                    : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#e6edf3]'
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
