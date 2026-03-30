import React from 'react';

interface NavigationBarProps {
  currentIndex: number;
  total: number;
  onFirst: () => void;
  onPrev: () => void;
  onNext: () => void;
  onLatest: () => void;
  promptsOnly: boolean;
  riskyOnly: boolean;
  collapseHistory: boolean;
  autoScroll: boolean;
  onTogglePromptsOnly: () => void;
  onToggleRiskyOnly: () => void;
  onToggleCollapseHistory: () => void;
  onToggleAutoScroll: () => void;
  onPrint?: () => void;
  availableAgentTypes?: string[];
  activeAgentTypes?: string[];
  onToggleAgentType?: (agentType: string) => void;
}

const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'codex': 'Codex',
  'opencode': 'OpenCode',
  'mistral-vibe': 'Mistral Vibe',
  'cline': 'Cline',
};

const AGENT_ORDER = ['claude-code', 'codex', 'opencode', 'mistral-vibe', 'cline'];

function sortAgentTypes(types: string[]): string[] {
  return [...types].sort((a, b) => {
    const ai = AGENT_ORDER.indexOf(a);
    const bi = AGENT_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

export function NavigationBar({
  currentIndex,
  total,
  onFirst,
  onPrev,
  onNext,
  onLatest,
  promptsOnly,
  riskyOnly,
  collapseHistory,
  autoScroll,
  onTogglePromptsOnly,
  onToggleRiskyOnly,
  onToggleCollapseHistory,
  onToggleAutoScroll,
  onPrint,
  availableAgentTypes,
  activeAgentTypes,
  onToggleAgentType,
}: NavigationBarProps) {
  return (
    <div data-print-hide className="flex items-center gap-3 px-4 py-2 bg-[#161b22] border-b border-[#30363d] text-xs flex-wrap">
      <div className="flex items-center gap-1">
        <button
          onClick={onFirst}
          disabled={currentIndex === 0 || total === 0}
          title="First event"
          className="p-1 text-[#8b949e] hover:text-[#e6edf3] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          ⏮
        </button>
        <button
          onClick={onPrev}
          disabled={currentIndex === 0 || total === 0}
          title="Previous event"
          className="p-1 text-[#8b949e] hover:text-[#e6edf3] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          ◀
        </button>
        <span className="px-2 text-[#8b949e] tabular-nums">
          {total === 0 ? 'No events' : `${currentIndex + 1} of ${total}`}
        </span>
        <button
          onClick={onNext}
          disabled={currentIndex >= total - 1 || total === 0}
          title="Next event"
          className="p-1 text-[#8b949e] hover:text-[#e6edf3] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          ▶
        </button>
        <button
          onClick={onLatest}
          disabled={currentIndex >= total - 1 || total === 0}
          title="Latest event"
          className="p-1 text-[#8b949e] hover:text-[#e6edf3] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          ⏭
        </button>
      </div>

      <div className="h-4 w-px bg-[#30363d]" />

      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[#484f58]">Display:</span>

        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={promptsOnly}
            onChange={onTogglePromptsOnly}
            className="w-3 h-3 accent-[#58a6ff]"
          />
          <span className={promptsOnly ? 'text-[#58a6ff]' : 'text-[#8b949e]'}>Prompts only</span>
        </label>

        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={riskyOnly}
            onChange={onToggleRiskyOnly}
            className="w-3 h-3 accent-[#d29922]"
          />
          <span className={riskyOnly ? 'text-[#d29922]' : 'text-[#8b949e]'}>Risky only</span>
        </label>

        <label className="flex items-center gap-1.5 cursor-pointer" title="Collapse all entries unless explicitly opened">
          <input
            type="checkbox"
            checked={collapseHistory}
            onChange={onToggleCollapseHistory}
            className="w-3 h-3 accent-[#8b949e]"
          />
          <span className={collapseHistory ? 'text-[#e6edf3]' : 'text-[#8b949e]'}>Collapse history</span>
        </label>

        <label className="flex items-center gap-1.5 cursor-pointer" title="Automatically scroll to newest entries">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={onToggleAutoScroll}
            className="w-3 h-3 accent-[#3fb950]"
          />
          <span className={autoScroll ? 'text-[#3fb950]' : 'text-[#8b949e]'}>Auto-scroll</span>
        </label>

        {availableAgentTypes && availableAgentTypes.length > 1 && onToggleAgentType && (
          <>
            <div className="h-4 w-px bg-[#30363d]" />
            <span className="text-[#484f58]">Agents:</span>
            {sortAgentTypes(availableAgentTypes).map((at) => {
              const isActive = !activeAgentTypes || activeAgentTypes.length === 0 || activeAgentTypes.includes(at);
              const label = AGENT_LABELS[at] ?? at;
              return (
                <label key={at} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={() => onToggleAgentType(at)}
                    className="w-3 h-3 accent-[#a371f7]"
                  />
                  <span className={isActive ? 'text-[#a371f7]' : 'text-[#8b949e]'}>{label}</span>
                </label>
              );
            })}
          </>
        )}

        {onPrint && (
          <>
            <div className="h-4 w-px bg-[#30363d]" />
            <button
              onClick={onPrint}
              className="flex items-center gap-1 text-[#8b949e] hover:text-[#e6edf3] transition-colors"
              title="Export to PDF"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
              Export
            </button>
          </>
        )}
      </div>
    </div>
  );
}
