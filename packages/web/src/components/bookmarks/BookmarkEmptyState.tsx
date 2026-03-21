import React, { useState, useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';

interface BookmarkEmptyStateProps {
  recordingEnabled: boolean;
  onSend: (msg: ClientMessage) => void;
}

export function BookmarkEmptyState({ recordingEnabled, onSend }: BookmarkEmptyStateProps) {
  const [confirming, setConfirming] = useState(false);

  const handleEnable = useCallback(() => {
    onSend({ type: 'config:update', config: { sessionRecording: true } });
    setConfirming(false);
  }, [onSend]);

  if (recordingEnabled) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
        <div className="text-4xl opacity-30">🔴</div>
        <div>
          <p className="text-sm font-medium text-[#e6edf3] mb-1">Recording is active</p>
          <p className="text-xs text-[#8b949e]">
            Sessions will appear here after your next Claude Code session.
            Bookmark the ones you want to keep.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
      <div className="text-4xl opacity-30">🔖</div>
      <div>
        <p className="text-sm font-medium text-[#e6edf3] mb-1">No bookmarks yet</p>
        <p className="text-xs text-[#8b949e]">
          Session recording is currently disabled. Enable it to start capturing Claude Code sessions,
          then bookmark the ones you want to keep.
        </p>
        <p className="text-[10px] text-[#484f58] mt-2">
          You can also enable recording in Settings.
        </p>
      </div>

      {confirming ? (
        <div className="bg-[#21262d] border border-[#30363d] rounded-lg p-4 max-w-xs w-full">
          <p className="text-xs text-[#e6edf3] mb-3">
            Enable session recording? All future Claude Code sessions will be saved to{' '}
            <code className="text-[#8b949e]">~/.claude/layman.db</code>.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleEnable}
              className="flex-1 px-3 py-1.5 text-xs font-medium rounded bg-[#238636] border border-[#2ea043] text-white hover:bg-[#2ea043] transition-colors"
            >
              Enable
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="flex-1 px-3 py-1.5 text-xs rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="px-4 py-2 text-xs font-medium rounded-md bg-[#1f6feb] border border-[#388bfd] text-white hover:bg-[#388bfd] transition-colors"
        >
          Enable Session Recording
        </button>
      )}
    </div>
  );
}
