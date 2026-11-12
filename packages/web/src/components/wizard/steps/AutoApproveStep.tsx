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
      <h2 className="text-base font-semibold text-text mb-1">Approval automation</h2>
      <p className="text-xs text-text-muted mb-5">
        Control which tool calls are automatically approved without your sign-off. Permission requests
        — where the AI explicitly asks you a question — are always shown regardless of these settings.
      </p>

      {/* Auto-Approve threshold */}
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
        Auto-Approve
      </h3>
      <div className="flex rounded-md overflow-hidden border border-border-strong mb-2">
        {(['all', 'medium', 'low', 'none'] as const).map((level) => {
          const isActive = config.autoApprove === level;
          const labels: Record<string, string> = { all: 'All', medium: 'Medium', low: 'Low', none: 'None' };
          return (
            <button
              key={level}
              onClick={() => onConfigChange({ autoApprove: level })}
              className={`flex-1 py-1.5 text-xs font-mono transition-colors ${
                isActive ? 'bg-ok text-text-on-fill' : 'text-text-muted hover:text-text hover:bg-bg-pill'
              }`}
            >
              {labels[level]}
            </button>
          );
        })}
      </div>
      <div className="text-[10px] text-text-faint space-y-1 mb-5">
        <p><span className="text-text-muted">All</span> — every tool call is auto-approved</p>
        <p><span className="text-text-muted">Medium</span> — low + medium risk auto-approved; high requires sign-off</p>
        <p><span className="text-text-muted">Low</span> — only low-risk tools auto-approved; medium + high require sign-off</p>
        <p><span className="text-text-muted">None</span> — every tool call requires manual approval</p>
      </div>

      {/* Auto-Allow Rules */}
      <div className="border-t border-border-strong pt-4">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
          Auto-Allow Rules
        </h3>
        <div className="space-y-3">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-xs text-text">Auto-allow read-only tools</span>
            <div
              onClick={() => updateAutoAllow({ readOnly: !config.autoAllow.readOnly })}
              className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
                config.autoAllow.readOnly ? 'bg-ok' : 'bg-border-strong'
              }`}
            >
              <div
                className={`absolute top-0.5 w-3 h-3 bg-text rounded-full transition-transform ${
                  config.autoAllow.readOnly ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </div>
          </label>
          <p className="text-[10px] text-text-faint">
            Read, Glob, Grep, WebSearch are auto-approved without prompting
          </p>

          <div>
            <label className="text-xs text-text-muted block mb-1">
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
              className="w-full px-3 py-2 text-xs font-mono bg-bg border border-border-strong rounded-md text-text placeholder-text-faint focus:outline-none focus:border-accent resize-y"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
