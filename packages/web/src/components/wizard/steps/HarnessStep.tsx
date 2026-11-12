import { HarnessSetupSection } from '../../controls/SettingsDrawer.js';
import type { ClientMessage } from '../../../lib/ws-protocol.js';

interface HarnessStepProps {
  onSend: (msg: ClientMessage) => void;
}

export function HarnessStep({ onSend }: HarnessStepProps) {
  return (
    <div>
      <h2 className="text-base font-semibold text-text mb-1">Connect your AI agents</h2>
      <p className="text-xs text-text-muted mb-5">
        Layman monitors AI agent sessions by installing lightweight hooks into your development tools.
        Select which agents to connect — you can change this later in Settings.
      </p>
      <HarnessSetupSection onSend={onSend} />
    </div>
  );
}
