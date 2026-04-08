import type { LaymanConfig } from '../../../lib/types.js';

interface AutoApproveStepProps {
  config: LaymanConfig;
  onConfigChange: (updates: Partial<LaymanConfig>) => void;
}

export function AutoApproveStep({ config, onConfigChange }: AutoApproveStepProps) {
  const updateAutoAllow = (updates: Partial<LaymanConfig['autoAllow']>) => {
    onConfigChange({ autoAllow: { ...config.autoAllow, ...updates } });
  };

  return (
    <div>
      <h2 className="text-base font-semibold text-[#e6edf3] mb-1">Approval automation</h2>
      <p className="text-xs text-[#8b949e] mb-5">
        Control which tool calls are automatically approved without your sign-off. Permission requests
        — where the AI explicitly asks you a question — are always shown regardless of these settings.
      </p>

      {/* Auto-Approve threshold */}
      <h3 className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider mb-2">
        Auto-Approve
      </h3>
      <div className="flex rounded-md overflow-hidden border border-[#30363d] mb-2">
        {(['all', 'medium', 'low', 'none'] as const).map((level) => {
          const isActive = (config.autoApprove as string) === level;
          const labels: Record<string, string> = { all: 'All', medium: 'Medium', low: 'Low', none: 'None' };
          return (
            <button
              key={level}
              onClick={() => onConfigChange({ autoApprove: level })}
              className={`flex-1 py-1.5 text-xs font-mono transition-colors ${
                isActive ? 'bg-[#238636] text-white' : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
              }`}
            >
              {labels[level]}
            </button>
          );
        })}
      </div>
      <div className="text-[10px] text-[#484f58] space-y-1 mb-5">
        <p><span className="text-[#8b949e]">All</span> — every tool call is auto-approved</p>
        <p><span className="text-[#8b949e]">Medium</span> — low + medium risk auto-approved; high requires sign-off</p>
        <p><span className="text-[#8b949e]">Low</span> — only low-risk tools auto-approved; medium + high require sign-off</p>
        <p><span className="text-[#8b949e]">None</span> — every tool call requires manual approval</p>
      </div>

      {/* Auto-Allow Rules */}
      <div className="border-t border-[#30363d] pt-4">
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
            Read, Glob, Grep, WebSearch are auto-approved without prompting
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
              rows={3}
              className="w-full px-3 py-2 text-xs font-mono bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] resize-y"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
