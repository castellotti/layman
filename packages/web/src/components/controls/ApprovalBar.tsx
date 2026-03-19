import React, { useState } from 'react';
import type { ClientMessage } from '../../lib/ws-protocol.js';

interface ApprovalBarProps {
  approvalId: string;
  toolName: string;
  onSend: (msg: ClientMessage) => void;
}

export function ApprovalBar({ approvalId, onSend }: ApprovalBarProps) {
  const [showDeny, setShowDeny] = useState(false);
  const [denyReason, setDenyReason] = useState('');
  const [decided, setDecided] = useState(false);

  const handleAllow = () => {
    if (decided) return;
    setDecided(true);
    onSend({ type: 'approval:decide', approvalId, decision: { decision: 'allow' } });
  };

  const handleDeny = () => {
    if (decided) return;
    if (!showDeny) { setShowDeny(true); return; }
    setDecided(true);
    onSend({ type: 'approval:decide', approvalId, decision: { decision: 'deny', reason: denyReason.trim() || undefined } });
  };

  const handleDefer = () => {
    if (decided) return;
    setDecided(true);
    onSend({ type: 'approval:decide', approvalId, decision: { decision: 'ask' } });
  };

  if (decided) {
    return (
      <div className="text-xs text-[#8b949e] italic">Decision sent — waiting for Claude Code to continue...</div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          onClick={handleAllow}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md bg-[#238636] hover:bg-[#2ea043] text-white transition-colors border border-[#3fb950]/30"
        >
          ✓ Allow
        </button>

        <button
          onClick={handleDeny}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md bg-[#da3633]/20 hover:bg-[#da3633]/30 text-[#f85149] transition-colors border border-[#f85149]/30"
        >
          ✕ Deny
        </button>

        <button
          onClick={handleDefer}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] transition-colors border border-[#30363d]"
          title="Pass the decision to the terminal prompt"
        >
          ⏭ Defer
        </button>
      </div>

      {showDeny && (
        <div className="flex gap-2">
          <input
            type="text"
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
            placeholder="Reason for denial (optional)..."
            className="flex-1 px-3 py-1.5 text-xs bg-[#0d1117] border border-[#f85149]/30 rounded-md text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#f85149]"
            onKeyDown={(e) => { if (e.key === 'Enter') handleDeny(); if (e.key === 'Escape') setShowDeny(false); }}
            autoFocus
          />
          <button
            onClick={handleDeny}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-[#da3633]/20 text-[#f85149] border border-[#f85149]/30 hover:bg-[#da3633]/30 transition-colors"
          >
            Confirm
          </button>
          <button
            onClick={() => setShowDeny(false)}
            className="px-2 py-1.5 text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
