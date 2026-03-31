import React from 'react';

interface NavigationBarProps {
  currentIndex: number;
  total: number;
  onFirst: () => void;
  onPrev: () => void;
  onNext: () => void;
  onLatest: () => void;
  promptsOnly: boolean;
  responsesOnly: boolean;
  riskyOnly: boolean;
  onTogglePromptsOnly: () => void;
  onToggleResponsesOnly: () => void;
  onToggleRiskyOnly: () => void;
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
  responsesOnly,
  riskyOnly,
  onTogglePromptsOnly,
  onToggleResponsesOnly,
  onToggleRiskyOnly,
  onPrint,
  availableAgentTypes,
  activeAgentTypes,
  onToggleAgentType,
}: NavigationBarProps) {
  return (
    <div data-print-hide className="flex items-center gap-3 px-4 py-2 bg-[#161b22] border-b border-[#30363d] text-xs flex-wrap">
      {/* Navigation arrows */}
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

      {/* Filter pills */}
      <div className="flex items-center gap-1.5">
        <span className="text-[#484f58]">Display:</span>
        <button
          onClick={onTogglePromptsOnly}
          className={`px-2 py-0.5 text-[10px] rounded-full border transition-colors ${
            promptsOnly
              ? 'bg-[#21262d] border-[#58a6ff] text-[#e6edf3]'
              : 'bg-transparent border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
          }`}
          title="Show only prompts & approvals (P)"
        >
          Prompts
        </button>

        <button
          onClick={onToggleResponsesOnly}
          className={`px-2 py-0.5 text-[10px] rounded-full border transition-colors ${
            responsesOnly
              ? 'bg-[#21262d] border-[#58a6ff] text-[#e6edf3]'
              : 'bg-transparent border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
          }`}
          title="Show only agent responses (O)"
        >
          Responses
        </button>

        <button
          onClick={onToggleRiskyOnly}
          className={`px-2 py-0.5 text-[10px] rounded-full border transition-colors ${
            riskyOnly
              ? 'bg-[#21262d] border-[#d29922] text-[#d29922]'
              : 'bg-transparent border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
          }`}
          title="Show only medium/high risk events (R)"
        >
          Risky
        </button>
      </div>

      {/* Agent type pills */}
      {availableAgentTypes && availableAgentTypes.length > 1 && onToggleAgentType && (
        <>
          <div className="h-4 w-px bg-[#30363d]" />
          <div className="flex items-center gap-1.5">
            {sortAgentTypes(availableAgentTypes).map((at) => {
              const isActive = !activeAgentTypes || activeAgentTypes.length === 0 || activeAgentTypes.includes(at);
              const label = AGENT_LABELS[at] ?? at;
              return (
                <button
                  key={at}
                  onClick={() => onToggleAgentType(at)}
                  className={`px-2 py-0.5 text-[10px] rounded-full border transition-colors ${
                    isActive
                      ? 'bg-[#21262d] border-[#a371f7] text-[#a371f7]'
                      : 'bg-transparent border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                  }`}
                  title={`Toggle ${label}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* Export */}
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
  );
}
