import { useState, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../lib/types.js';
import { HarnessStep } from './steps/HarnessStep.js';
import { AnalysisModelStep } from './steps/AnalysisModelStep.js';
import { AutoExplainStep } from './steps/AutoExplainStep.js';
import { AutoAnalysisStep } from './steps/AutoAnalysisStep.js';
import { AutoApproveStep } from './steps/AutoApproveStep.js';
import { DriftMonitoringStep } from './steps/DriftMonitoringStep.js';

const STEPS = [
  { label: 'Agents' },
  { label: 'Model' },
  { label: 'Explain' },
  { label: 'Analyze' },
  { label: 'Approve' },
  { label: 'Drift' },
] as const;

const TOTAL_STEPS = STEPS.length;

/** Shared wizard modal UI — used by both first-run and manual launch. */
function WizardModal({ onSend, onClose, isFirstRun }: {
  onSend: (msg: ClientMessage) => void;
  onClose: () => void;
  isFirstRun: boolean;
}) {
  const config = useSessionStore((s) => s.config);

  const [currentStep, setCurrentStep] = useState(0);
  const [draftConfig, setDraftConfig] = useState<LaymanConfig | null>(null);

  // Initialize draft config from current live config
  useEffect(() => {
    if (config && !draftConfig) {
      setDraftConfig({ ...config });
    }
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  // NOTE: Nested config sections (analysis, autoAllow, driftMonitoring) must be
  // explicitly spread here. If a new nested section is added to LaymanConfig,
  // update this merge logic to match.
  const handleConfigChange = useCallback((updates: Partial<LaymanConfig>) => {
    setDraftConfig((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        ...updates,
        analysis: { ...prev.analysis, ...updates.analysis },
        autoAllow: { ...prev.autoAllow, ...updates.autoAllow },
        driftMonitoring: {
          ...prev.driftMonitoring,
          ...updates.driftMonitoring,
          sessionDriftThresholds: {
            ...prev.driftMonitoring.sessionDriftThresholds,
            ...updates.driftMonitoring?.sessionDriftThresholds,
          },
          rulesDriftThresholds: {
            ...prev.driftMonitoring.rulesDriftThresholds,
            ...updates.driftMonitoring?.rulesDriftThresholds,
          },
        },
      };
    });
  }, []);

  const handleClose = useCallback(() => {
    if (isFirstRun) {
      onSend({ type: 'config:update', config: { setupWizardComplete: true } });
    }
    onClose();
  }, [isFirstRun, onSend, onClose]);

  const handleFinish = useCallback(() => {
    if (draftConfig) {
      const { port, host, ...configToSend } = draftConfig;
      onSend({ type: 'config:update', config: { ...configToSend, setupWizardComplete: true } });
    } else {
      onSend({ type: 'config:update', config: { setupWizardComplete: true } });
    }
    onClose();
  }, [draftConfig, onSend, onClose]);

  const handleNext = useCallback(() => {
    if (currentStep < TOTAL_STEPS - 1) {
      setCurrentStep((s) => s + 1);
    }
  }, [currentStep]);

  const handleBack = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep((s) => s - 1);
    }
  }, [currentStep]);

  // Escape key closes
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleClose]);

  if (!config || !draftConfig) return null;

  const isLastStep = currentStep === TOTAL_STEPS - 1;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="w-full max-w-2xl mx-4 bg-[#161b22] border border-[#30363d] rounded-lg shadow-2xl flex flex-col" style={{ maxHeight: '85vh' }}>
        {/* Header with progress indicator */}
        <div className="px-6 pt-5 pb-4 border-b border-[#30363d] shrink-0">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-sm font-semibold text-[#e6edf3]">Setup Wizard</h1>
            <button
              onClick={handleClose}
              className="text-[#8b949e] hover:text-[#e6edf3] transition-colors text-lg leading-none"
              title="Close"
            >
              ×
            </button>
          </div>

          {/* Progress dots */}
          <div className="flex items-center justify-center gap-3">
            {STEPS.map((step, i) => (
              <button
                key={i}
                onClick={() => setCurrentStep(i)}
                className="flex flex-col items-center gap-1 group"
              >
                <div
                  className={`w-3 h-3 rounded-full transition-colors ${
                    i === currentStep
                      ? 'bg-[#58a6ff]'
                      : i < currentStep
                        ? 'bg-[#238636]'
                        : 'border border-[#30363d] bg-transparent'
                  }`}
                />
                <span className={`text-[9px] transition-colors ${
                  i === currentStep
                    ? 'text-[#58a6ff]'
                    : i < currentStep
                      ? 'text-[#3fb950]'
                      : 'text-[#484f58]'
                }`}>
                  {step.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 min-h-0">
          {currentStep === 0 && <HarnessStep onSend={onSend} />}
          {currentStep === 1 && <AnalysisModelStep config={draftConfig} onConfigChange={handleConfigChange} />}
          {currentStep === 2 && <AutoExplainStep config={draftConfig} onConfigChange={handleConfigChange} />}
          {currentStep === 3 && <AutoAnalysisStep config={draftConfig} onConfigChange={handleConfigChange} />}
          {currentStep === 4 && <AutoApproveStep config={draftConfig} onConfigChange={handleConfigChange} />}
          {currentStep === 5 && <DriftMonitoringStep config={draftConfig} onConfigChange={handleConfigChange} />}
        </div>

        {/* Footer navigation */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[#30363d] shrink-0">
          <button
            onClick={handleClose}
            className="text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors"
          >
            {isFirstRun ? 'Skip setup' : 'Cancel'}
          </button>
          <div className="flex items-center gap-2">
            {currentStep > 0 && (
              <button
                onClick={handleBack}
                className="px-4 py-1.5 text-xs font-medium rounded bg-[#21262d] border border-[#30363d] text-[#e6edf3] hover:bg-[#30363d] transition-colors"
              >
                Back
              </button>
            )}
            <button
              onClick={isLastStep ? handleFinish : handleNext}
              className="px-4 py-1.5 text-xs font-medium rounded bg-[#238636] hover:bg-[#2ea043] text-white transition-colors"
            >
              {isLastStep ? (isFirstRun ? 'Finish' : 'Save') : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Auto-show wrapper for first-run onboarding. Renders in App.tsx. */
export function SetupWizard({ onSend }: { onSend: (msg: ClientMessage) => void }) {
  const { config, setupWizardDismissed, dismissSetupWizard } = useSessionStore((s) => ({
    config: s.config,
    setupWizardDismissed: s.setupWizardDismissed,
    dismissSetupWizard: s.dismissSetupWizard,
  }));

  if (!config || config.setupWizardComplete || setupWizardDismissed) return null;

  return (
    <WizardModal
      onSend={onSend}
      onClose={dismissSetupWizard}
      isFirstRun={true}
    />
  );
}

/** Manually launched wizard from Settings. Pre-populated with current config. */
export function SetupWizardManual({ onSend, onClose }: {
  onSend: (msg: ClientMessage) => void;
  onClose: () => void;
}) {
  return (
    <WizardModal
      onSend={onSend}
      onClose={onClose}
      isFirstRun={false}
    />
  );
}
