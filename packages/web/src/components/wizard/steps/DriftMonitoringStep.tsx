import type { LaymanConfig } from '../../../lib/types.js';

interface DriftMonitoringStepProps {
  config: LaymanConfig;
  onConfigChange: (updates: Partial<LaymanConfig>) => void;
}

export function DriftMonitoringStep({ config, onConfigChange }: DriftMonitoringStepProps) {
  const parseNum = (v: string, min: number) => {
    const n = parseInt(v, 10);
    return isNaN(n) ? min : n;
  };

  const updateDrift = (updates: Partial<LaymanConfig['driftMonitoring']>) => {
    onConfigChange({ driftMonitoring: { ...config.driftMonitoring, ...updates } });
  };

  const updateSessionThresholds = (updates: Partial<LaymanConfig['driftMonitoring']['sessionDriftThresholds']>) => {
    updateDrift({ sessionDriftThresholds: { ...config.driftMonitoring.sessionDriftThresholds, ...updates } });
  };

  const updateRulesThresholds = (updates: Partial<LaymanConfig['driftMonitoring']['rulesDriftThresholds']>) => {
    updateDrift({ rulesDriftThresholds: { ...config.driftMonitoring.rulesDriftThresholds, ...updates } });
  };

  const thresholdsOutOfOrder =
    config.driftMonitoring.sessionDriftThresholds.green >= config.driftMonitoring.sessionDriftThresholds.yellow
    || config.driftMonitoring.sessionDriftThresholds.yellow >= config.driftMonitoring.sessionDriftThresholds.orange
    || config.driftMonitoring.rulesDriftThresholds.green >= config.driftMonitoring.rulesDriftThresholds.yellow
    || config.driftMonitoring.rulesDriftThresholds.yellow >= config.driftMonitoring.rulesDriftThresholds.orange;

  return (
    <div>
      <h2 className="text-base font-semibold text-[#e6edf3] mb-1">Drift monitoring</h2>
      <p className="text-xs text-[#8b949e] mb-5">
        Drift monitoring periodically checks whether your AI agent is staying on task and following your
        project rules (CLAUDE.md / AGENTS.md). When drift is detected, Layman can warn you or pause the
        agent until you review.
      </p>

      <div className="space-y-3">
        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-xs text-[#e6edf3]">Enable drift monitoring</span>
          <div
            onClick={() => updateDrift({ enabled: !config.driftMonitoring.enabled })}
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
                    const v = parseNum(e.target.value, 1);
                    if (v >= 1 && v <= 100) updateDrift({ checkIntervalToolCalls: v });
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
                    const v = parseNum(e.target.value, 1);
                    if (v >= 1 && v <= 60) updateDrift({ checkIntervalMinutes: v });
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
                    const v = parseNum(e.target.value, 0);
                    if (v >= 0 && v <= 100) updateSessionThresholds({ green: v });
                  }}
                  className="w-12 px-1 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                />
                <span className="text-[10px]" style={{ color: '#ffb300' }}>Yellow</span>
                <input
                  type="number" min={0} max={100}
                  value={config.driftMonitoring.sessionDriftThresholds.yellow}
                  onChange={(e) => {
                    const v = parseNum(e.target.value, 0);
                    if (v >= 0 && v <= 100) updateSessionThresholds({ yellow: v });
                  }}
                  className="w-12 px-1 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                />
                <span className="text-[10px]" style={{ color: '#ff9100' }}>Orange</span>
                <input
                  type="number" min={0} max={100}
                  value={config.driftMonitoring.sessionDriftThresholds.orange}
                  onChange={(e) => {
                    const v = parseNum(e.target.value, 0);
                    if (v >= 0 && v <= 100) updateSessionThresholds({ orange: v });
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
                    const v = parseNum(e.target.value, 0);
                    if (v >= 0 && v <= 100) updateRulesThresholds({ green: v });
                  }}
                  className="w-12 px-1 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                />
                <span className="text-[10px]" style={{ color: '#ffb300' }}>Yellow</span>
                <input
                  type="number" min={0} max={100}
                  value={config.driftMonitoring.rulesDriftThresholds.yellow}
                  onChange={(e) => {
                    const v = parseNum(e.target.value, 0);
                    if (v >= 0 && v <= 100) updateRulesThresholds({ yellow: v });
                  }}
                  className="w-12 px-1 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                />
                <span className="text-[10px]" style={{ color: '#ff9100' }}>Orange</span>
                <input
                  type="number" min={0} max={100}
                  value={config.driftMonitoring.rulesDriftThresholds.orange}
                  onChange={(e) => {
                    const v = parseNum(e.target.value, 0);
                    if (v >= 0 && v <= 100) updateRulesThresholds({ orange: v });
                  }}
                  className="w-12 px-1 py-1 text-xs text-center bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                />
                <span className="text-[10px]" style={{ color: '#ff3d57' }}>Red</span>
              </div>
            </div>

            {/* Threshold ordering warning */}
            {thresholdsOutOfOrder && (
              <p className="text-[10px] text-[#d29922]">
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
                onClick={() => updateDrift({ blockOnRed: !config.driftMonitoring.blockOnRed })}
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
                onClick={() => updateDrift({ remindOnOrange: !config.driftMonitoring.remindOnOrange })}
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
    </div>
  );
}
