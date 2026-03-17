import React, { useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { useEventStore } from '../../hooks/useEventStore.js';
import { AnalysisCard } from '../analysis/AnalysisCard.js';
import { AskQuestion } from '../analysis/AskQuestion.js';
import { RiskBadge } from '../shared/RiskBadge.js';
import { CodeBlock } from '../shared/CodeBlock.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';

interface InvestigationPanelProps {
  onSend: (msg: ClientMessage) => void;
}

export function InvestigationPanel({ onSend }: InvestigationPanelProps) {
  const {
    selectedEventId,
    investigationOpen,
    setInvestigationOpen,
    investigationState,
    addInvestigationQuestion,
    analyzingEventIds,
  } = useSessionStore();

  const { getEvent } = useEventStore();
  const [isAskingQuestion, setIsAskingQuestion] = useState(false);

  if (!investigationOpen || !selectedEventId) return null;

  const event = getEvent(selectedEventId);
  if (!event) return null;

  const state = investigationState[selectedEventId] ?? { questions: [], isAnalyzing: false };
  const isAnalyzing = analyzingEventIds.has(selectedEventId);

  const handleRequestAnalysis = (depth: 'quick' | 'detailed') => {
    onSend({ type: 'analysis:request', eventId: selectedEventId, depth });
  };

  const handleAsk = async (question: string) => {
    setIsAskingQuestion(true);
    try {
      const response = await fetch(`/api/analysis/${selectedEventId}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (response.ok) {
        const data = await response.json() as { answer: string };
        addInvestigationQuestion(selectedEventId, question, data.answer);
      }
    } catch {
      addInvestigationQuestion(selectedEventId, question, 'Failed to get answer. Please try again.');
    } finally {
      setIsAskingQuestion(false);
    }
  };

  const formatInput = (input: Record<string, unknown>): string => {
    if ('command' in input) return String(input.command);
    return JSON.stringify(input, null, 2);
  };

  return (
    <div className="flex flex-col h-full border-l border-[#30363d] bg-[#0d1117]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d] bg-[#161b22] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[#e6edf3]">Investigation</span>
          {event.riskLevel && <RiskBadge level={event.riskLevel} compact />}
        </div>
        <button
          onClick={() => setInvestigationOpen(false)}
          className="text-[#8b949e] hover:text-[#e6edf3] transition-colors text-lg leading-none"
        >
          ×
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Event detail */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-mono text-[#8b949e] uppercase">{event.type.replace(/_/g, ' ')}</span>
            {event.data.toolName && (
              <span className="text-xs font-semibold text-[#e6edf3]">{event.data.toolName}</span>
            )}
          </div>

          {event.data.toolInput && (
            <CodeBlock
              code={formatInput(event.data.toolInput)}
              language={event.data.toolName === 'Bash' ? 'bash' : 'text'}
              maxLines={15}
            />
          )}

          {event.data.prompt && (
            <blockquote className="text-xs text-[#e6edf3] border-l-2 border-[#58a6ff] pl-3 italic">
              {event.data.prompt}
            </blockquote>
          )}
        </div>

        {/* Analysis section */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-[#484f58] font-mono uppercase tracking-wider">
              Analysis
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => handleRequestAnalysis('quick')}
                disabled={isAnalyzing}
                className="text-[10px] text-[#58a6ff] hover:text-[#79c0ff] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isAnalyzing ? '⏳ Analyzing...' : 'Quick'}
              </button>
              <span className="text-[10px] text-[#484f58]">·</span>
              <button
                onClick={() => handleRequestAnalysis('detailed')}
                disabled={isAnalyzing}
                className="text-[10px] text-[#58a6ff] hover:text-[#79c0ff] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Detailed
              </button>
            </div>
          </div>

          {event.analysis ? (
            <div className="bg-[#161b22] border border-[#30363d] rounded-md p-3">
              <AnalysisCard analysis={event.analysis} />
            </div>
          ) : isAnalyzing ? (
            <div className="bg-[#161b22] border border-[#30363d] rounded-md p-4 text-center">
              <span className="text-xs text-[#8b949e] animate-pulse">Analyzing with LLM...</span>
            </div>
          ) : (
            <div className="bg-[#161b22] border border-[#30363d] border-dashed rounded-md p-4 text-center">
              <span className="text-xs text-[#484f58]">No analysis yet. Click Quick or Detailed above.</span>
            </div>
          )}
        </div>

        {/* Investigation Q&A */}
        {state.questions.length > 0 && (
          <div className="space-y-3">
            <span className="text-[10px] text-[#484f58] font-mono uppercase tracking-wider block">
              Questions
            </span>
            {state.questions.map((qa, i) => (
              <div key={i} className="space-y-1">
                <div className="flex gap-2">
                  <span className="text-[#58a6ff] text-xs shrink-0">Q:</span>
                  <span className="text-xs text-[#8b949e]">{qa.question}</span>
                </div>
                <div className="flex gap-2 ml-4">
                  <span className="text-[#3fb950] text-xs shrink-0">A:</span>
                  <span className="text-xs text-[#e6edf3]">{qa.answer}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Ask question input */}
        <div>
          <span className="text-[10px] text-[#484f58] font-mono uppercase tracking-wider block mb-2">
            Ask a question
          </span>
          <AskQuestion
            eventId={selectedEventId}
            onAsk={handleAsk}
            isLoading={isAskingQuestion}
          />
        </div>
      </div>
    </div>
  );
}
