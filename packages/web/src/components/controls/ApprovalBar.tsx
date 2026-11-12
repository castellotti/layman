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
      <div className="text-xs text-text-muted italic">Decision sent — waiting for Claude Code to continue...</div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          onClick={handleAllow}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md bg-ok hover:bg-[color-mix(in_srgb,var(--ok)_85%,var(--text))] text-text-on-fill transition-colors border border-ok/30"
        >
          ✓ Allow
        </button>

        <button
          onClick={handleDeny}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md bg-error/20 hover:bg-error/30 text-error transition-colors border border-error/30"
        >
          ✕ Deny
        </button>

        <button
          onClick={handleDefer}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md bg-bg-pill hover:bg-border-strong text-text-muted transition-colors border border-border-strong"
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
            className="flex-1 px-3 py-1.5 text-xs bg-bg border border-error/30 rounded-md text-text placeholder-text-faint focus:outline-none focus:border-error"
            onKeyDown={(e) => { if (e.key === 'Enter') handleDeny(); if (e.key === 'Escape') setShowDeny(false); }}
            autoFocus
          />
          <button
            onClick={handleDeny}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-error/20 text-error border border-error/30 hover:bg-error/30 transition-colors"
          >
            Confirm
          </button>
          <button
            onClick={() => setShowDeny(false)}
            className="px-2 py-1.5 text-xs text-text-muted hover:text-text transition-colors"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
