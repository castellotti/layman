import React, { useState } from 'react';
import type { ClientMessage } from '../../lib/ws-protocol.js';

interface ApprovalBarProps {
  approvalId: string;
  toolName: string;
  onSend: (msg: ClientMessage) => void;
}

export function ApprovalBar({ approvalId, toolName: _toolName, onSend }: ApprovalBarProps) {
  const [showDenyReason, setShowDenyReason] = useState(false);
  const [denyReason, setDenyReason] = useState('');
  const [decided, setDecided] = useState(false);

  const handleApprove = () => {
    if (decided) return;
    setDecided(true);
    onSend({
      type: 'approval:decide',
      approvalId,
      decision: { decision: 'allow' },
    });
  };

  const handleDeny = () => {
    if (decided) return;
    if (showDenyReason) {
      setDecided(true);
      onSend({
        type: 'approval:decide',
        approvalId,
        decision: { decision: 'deny', reason: denyReason || undefined },
      });
    } else {
      setShowDenyReason(true);
    }
  };

  const handleSkip = () => {
    if (decided) return;
    setDecided(true);
    onSend({
      type: 'approval:decide',
      approvalId,
      decision: { decision: 'ask' },
    });
  };

  if (decided) {
    return (
      <div className="flex items-center gap-2 text-xs text-[#8b949e]">
        <span>Decision sent...</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          onClick={handleApprove}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md bg-[#238636] hover:bg-[#2ea043] text-white transition-colors border border-[#3fb950]/30"
        >
          <span>✅</span>
          <span>Approve</span>
        </button>

        <button
          onClick={handleDeny}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md bg-[#da3633]/20 hover:bg-[#da3633]/30 text-[#f85149] transition-colors border border-[#f85149]/30"
        >
          <span>❌</span>
          <span>Deny</span>
        </button>

        <button
          onClick={handleSkip}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] transition-colors border border-[#30363d]"
        >
          <span>⏭</span>
          <span>Skip</span>
        </button>
      </div>

      {showDenyReason && (
        <div className="flex gap-2">
          <input
            type="text"
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
            placeholder="Reason for denial (optional)..."
            className="flex-1 px-3 py-1.5 text-xs bg-[#0d1117] border border-[#f85149]/30 rounded-md text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#f85149]"
            onKeyDown={(e) => e.key === 'Enter' && handleDeny()}
            autoFocus
          />
          <button
            onClick={handleDeny}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-[#da3633]/20 text-[#f85149] border border-[#f85149]/30 hover:bg-[#da3633]/30 transition-colors"
          >
            Confirm
          </button>
          <button
            onClick={() => setShowDenyReason(false)}
            className="px-3 py-1.5 text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      <p className="text-[10px] text-[#484f58]">
        <strong>Approve</strong> = allow · <strong>Deny</strong> = block with optional reason · <strong>Skip</strong> = defer to terminal prompt
      </p>
    </div>
  );
}
