import React, { useState, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { useSessionStore } from '../../stores/sessionStore.js';
import { useEventStore } from '../../hooks/useEventStore.js';
import { AnalysisCard } from '../analysis/AnalysisCard.js';
import { AskQuestion } from '../analysis/AskQuestion.js';
import { RiskBadge } from '../shared/RiskBadge.js';
import { CodeBlock } from '../shared/CodeBlock.js';
import { isMarkdown, MARKDOWN_PROSE, REMARK_PLUGINS } from '../../lib/markdown.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';

function MarkdownOrText({ text, className }: { text: string; className?: string }) {
  if (isMarkdown(text)) {
    return <div className={className ?? MARKDOWN_PROSE}><ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown></div>;
  }
  return <p className={className ?? 'text-xs text-[#e6edf3] leading-relaxed whitespace-pre-wrap'}>{text}</p>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-[10px] text-[#8b949e] hover:text-[#e6edf3] transition-colors shrink-0"
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  );
}

interface InvestigationPanelProps {
  onSend: (msg: ClientMessage) => void;
  /** When provided, renders in "embedded" mode for this specific event (e.g. inside BookmarksPanel) */
  eventId?: string;
  /** Called when user closes the embedded panel */
  onClose?: () => void;
}

export function InvestigationPanel({ onSend, eventId: embeddedEventId, onClose }: InvestigationPanelProps) {
  const {
    selectedEventId: storeSelectedEventId,
    investigationOpen,
    setInvestigationOpen,
    investigationState,
    addInvestigationQuestion,
    analyzingEventIds,
    laymansEventIds,
    laymansErrors,
    config,
    markSessionInvestigated,
  } = useSessionStore();

  const selectedEventId = embeddedEventId ?? storeSelectedEventId;

  const { getEvent } = useEventStore();
  const [isAskingQuestion, setIsAskingQuestion] = useState(false);
  const [askModel, setAskModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchModelError, setFetchModelError] = useState<string | null>(null);
  const [laymansDepth, setLaymansDepth] = useState<'quick' | 'detailed' | null>(null);
  const [analysisDepth, setAnalysisDepth] = useState<'quick' | 'detailed' | null>(null);
  const [isAskingFailure, setIsAskingFailure] = useState(false);

  const fetchModels = useCallback(async () => {
    if (!config) return;
    const p = config.analysis.provider;
    setFetchingModels(true);
    setFetchModelError(null);
    try {
      const params = new URLSearchParams({ provider: p });
      if (config.analysis.endpoint) params.set('endpoint', config.analysis.endpoint);
      const res = await fetch(`/api/models?${params}`);
      const data = await res.json() as { models?: string[]; error?: string };
      if (!res.ok || data.error) {
        setFetchModelError(data.error ?? `HTTP ${res.status}`);
        setAvailableModels([]);
      } else {
        const models = data.models ?? [];
        setAvailableModels(models);
        if (models.length && !askModel) setAskModel(models[0]);
      }
    } catch (err) {
      setFetchModelError(err instanceof Error ? err.message : String(err));
      setAvailableModels([]);
    } finally {
      setFetchingModels(false);
    }
  }, [config?.analysis.provider, config?.analysis.endpoint, askModel]);

  // Sync askModel default from config when config loads
  useEffect(() => {
    if (config?.analysis.model && !askModel) {
      setAskModel(config.analysis.model);
    }
  }, [config?.analysis.model]);

  // Reset depth tracking when navigating to a different event
  useEffect(() => {
    setLaymansDepth(null);
    setAnalysisDepth(null);
  }, [selectedEventId]);

  const isEmbedded = !!embeddedEventId;
  if (!isEmbedded && (!investigationOpen || !selectedEventId)) return null;
  if (!selectedEventId) return null;

  const event = getEvent(selectedEventId);
  if (!event) return null;

  const state = investigationState[selectedEventId] ?? { questions: [], isAnalyzing: false };
  const isAnalyzing = analyzingEventIds.has(selectedEventId);
  const isLaymansLoading = laymansEventIds.has(selectedEventId);
  const laymansError = laymansErrors[selectedEventId];
  const isBusy = isAnalyzing || isLaymansLoading;

  const handleRequestAnalysis = (depth: 'quick' | 'detailed') => {
    setAnalysisDepth(depth);
    markSessionInvestigated(event.sessionId);
    onSend({ type: 'analysis:request', eventId: selectedEventId, depth });
  };

  const handleRequestLaymans = (depth: 'quick' | 'detailed') => {
    setLaymansDepth(depth);
    markSessionInvestigated(event.sessionId);
    onSend({ type: 'laymans:request', eventId: selectedEventId, depth });
  };

  const handleRequestBoth = (depth: 'quick' | 'detailed') => {
    setLaymansDepth(depth);
    setAnalysisDepth(depth);
    markSessionInvestigated(event.sessionId);
    onSend({ type: 'both:request', eventId: selectedEventId, depth });
  };

  const handleAskWhyFailed = async (depth: 'quick' | 'detailed') => {
    const question = depth === 'quick'
      ? 'Why did this tool call fail and what was wrong?'
      : 'Why did this tool call fail? What was wrong with the approach, what error occurred, and what was the eventual solution or workaround? Provide a detailed analysis.';
    markSessionInvestigated(event.sessionId);
    setIsAskingFailure(true);
    try {
      const response = await fetch(`/api/analysis/${selectedEventId}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          ...(askModel ? { model: askModel } : {}),
          ...(event.laymans?.explanation ? { laymansTerms: event.laymans.explanation } : {}),
          ...(event.data.error ? { failureReason: String(event.data.error) } : {}),
          ...(state.questions.length > 0 ? {
            previousQuestions: state.questions.map((q) => ({ question: q.question, answer: q.answer })),
          } : {}),
        }),
      });
      if (response.ok) {
        const data = await response.json() as { answer: string; tokens?: { input: number; output: number }; latencyMs?: number; model?: string };
        addInvestigationQuestion(selectedEventId, question, data.answer, {
          tokens: data.tokens,
          latencyMs: data.latencyMs,
          model: data.model,
        });
      }
    } catch {
      addInvestigationQuestion(selectedEventId, question, 'Failed to get answer. Please try again.');
    } finally {
      setIsAskingFailure(false);
    }
  };

  const handleAsk = async (question: string) => {
    markSessionInvestigated(event.sessionId);
    setIsAskingQuestion(true);
    try {
      const response = await fetch(`/api/analysis/${selectedEventId}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          ...(askModel ? { model: askModel } : {}),
          ...(event.laymans?.explanation ? { laymansTerms: event.laymans.explanation } : {}),
          ...(event.data.error ? { failureReason: String(event.data.error) } : {}),
          ...(state.questions.length > 0 ? {
            previousQuestions: state.questions.map((q) => ({ question: q.question, answer: q.answer })),
          } : {}),
        }),
      });
      if (response.ok) {
        const data = await response.json() as { answer: string; tokens?: { input: number; output: number }; latencyMs?: number; model?: string };
        addInvestigationQuestion(selectedEventId, question, data.answer, {
          tokens: data.tokens,
          latencyMs: data.latencyMs,
          model: data.model,
        });
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
          <button
            onClick={() => { handleRequestLaymans('quick'); handleRequestAnalysis('detailed'); }}
            disabled={isBusy}
            title="Quick Layman's Terms + Detailed Analysis"
            className="text-sm font-bold text-[#e6edf3] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >Investigation</button>
          {event.riskLevel && <RiskBadge level={event.riskLevel} compact />}
        </div>
        <div className="flex items-center gap-2">
          {/* Quick combo button */}
          <button
            onClick={() => handleRequestBoth('quick')}
            disabled={isBusy}
            className="px-2 py-1 text-[10px] font-medium text-[#e6edf3] bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
          >
            {isBusy ? '⏳' : '⚡'} Quick
          </button>
          {/* Detailed combo button */}
          <button
            onClick={() => handleRequestBoth('detailed')}
            disabled={isBusy}
            className="px-2 py-1 text-[10px] font-medium text-[#e6edf3] bg-[#1f6feb] hover:bg-[#388bfd] disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
          >
            {isBusy ? '⏳' : '🔍'} Detailed
          </button>
          <button
            onClick={() => { if (onClose) onClose(); else setInvestigationOpen(false); }}
            className="text-[#8b949e] hover:text-[#e6edf3] transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>
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
              showWrapToggle={true}
              defaultWrapped={true}
            />
          )}

          {event.data.prompt && (
            <div className="bg-[#0d1117] border border-[#30363d] rounded-md overflow-hidden">
              <div className="flex items-center justify-end px-3 py-1 border-b border-[#30363d]">
                <CopyButton text={event.data.prompt as string} />
              </div>
              <div className="px-3 py-2 border-l-2 border-[#58a6ff]">
                <MarkdownOrText text={event.data.prompt as string} />
              </div>
            </div>
          )}
        </div>

        {/* Layman's Terms section */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono text-white uppercase">
              Layman&apos;s Terms
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => handleRequestLaymans('quick')}
                disabled={isLaymansLoading}
                className={`text-[10px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${event.laymans && laymansDepth === 'quick' ? 'text-white font-semibold' : 'text-[#3fb950] hover:text-[#56d364]'}`}
              >
                {isLaymansLoading && laymansDepth === 'quick' ? '⏳ Explaining...' : 'Quick'}
              </button>
              <span className="text-[10px] text-[#484f58]">·</span>
              <button
                onClick={() => handleRequestLaymans('detailed')}
                disabled={isLaymansLoading}
                className={`text-[10px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${event.laymans && laymansDepth === 'detailed' ? 'text-white font-semibold' : 'text-[#58a6ff] hover:text-[#79c0ff]'}`}
              >
                {isLaymansLoading && laymansDepth === 'detailed' ? '⏳ Explaining...' : 'Detailed'}
              </button>
            </div>
          </div>

          {event.laymans ? (
            <div className="bg-[#161b22] border border-[#30363d] rounded-md p-3 space-y-2">
              <MarkdownOrText text={event.laymans.explanation} />
              <div className="flex items-center gap-2 text-[10px] text-[#484f58] pt-1 border-t border-[#30363d]">
                {event.laymans.latencyMs !== undefined && <span>{event.laymans.latencyMs}ms</span>}
                {event.laymans.tokens && (
                  <>
                    <span>·</span>
                    <span className="text-[#3fb950]/70">↑{event.laymans.tokens.input.toLocaleString()}</span>
                    <span className="text-[#58a6ff]/70">↓{event.laymans.tokens.output.toLocaleString()}</span>
                  </>
                )}
                {event.laymans.model && <><span>·</span><span>{event.laymans.model}</span></>}
              </div>
            </div>
          ) : isLaymansLoading ? (
            <div className="bg-[#161b22] border border-[#30363d] rounded-md p-4 text-center">
              <span className="text-xs text-[#8b949e] animate-pulse">Explaining in plain language...</span>
            </div>
          ) : laymansError ? (
            <div className="bg-[#161b22] border border-[#f85149]/40 rounded-md p-3 space-y-1">
              <span className="text-xs font-semibold text-[#f85149]">Explanation failed</span>
              <p className="text-[11px] text-[#8b949e] font-mono break-all">{laymansError}</p>
            </div>
          ) : (
            <div className="bg-[#161b22] border border-[#30363d] border-dashed rounded-md p-4 text-center">
              <span className="text-xs text-[#484f58]">No explanation yet. Click Quick or Detailed above.</span>
            </div>
          )}
        </div>

        {/* Analysis section */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono text-white uppercase">
              Analysis
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => handleRequestAnalysis('quick')}
                disabled={isAnalyzing}
                className={`text-[10px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${event.analysis && analysisDepth === 'quick' ? 'text-white font-semibold' : 'text-[#3fb950] hover:text-[#56d364]'}`}
              >
                {isAnalyzing && analysisDepth === 'quick' ? '⏳ Analyzing...' : 'Quick'}
              </button>
              <span className="text-[10px] text-[#484f58]">·</span>
              <button
                onClick={() => handleRequestAnalysis('detailed')}
                disabled={isAnalyzing}
                className={`text-[10px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${event.analysis && analysisDepth === 'detailed' ? 'text-white font-semibold' : 'text-[#58a6ff] hover:text-[#79c0ff]'}`}
              >
                {isAnalyzing && analysisDepth === 'detailed' ? '⏳ Analyzing...' : 'Detailed'}
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
          ) : state.analysisError ? (
            <div className="bg-[#161b22] border border-[#f85149]/40 rounded-md p-3 space-y-1">
              <span className="text-xs font-semibold text-[#f85149]">Analysis failed</span>
              <p className="text-[11px] text-[#8b949e] font-mono break-all">{state.analysisError}</p>
              <p className="text-[10px] text-[#484f58] mt-1">
                Check Settings → Analysis Model. If using a local model, verify the endpoint is reachable.
              </p>
            </div>
          ) : (
            <div className="bg-[#161b22] border border-[#30363d] border-dashed rounded-md p-4 text-center">
              <span className="text-xs text-[#484f58]">No analysis yet. Click Quick or Detailed above.</span>
            </div>
          )}
        </div>

        {/* Failure Analysis section — only for tool_call_failed events */}
        {event.type === 'tool_call_failed' && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono text-white uppercase">
                Failure Analysis
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => void handleAskWhyFailed('quick')}
                  disabled={isAskingFailure || isAskingQuestion}
                  className="text-[10px] text-[#3fb950] hover:text-[#56d364] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isAskingFailure ? '⏳ Analyzing...' : 'Quick'}
                </button>
                <span className="text-[10px] text-[#484f58]">·</span>
                <button
                  onClick={() => void handleAskWhyFailed('detailed')}
                  disabled={isAskingFailure || isAskingQuestion}
                  className="text-[10px] text-[#58a6ff] hover:text-[#79c0ff] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Detailed
                </button>
              </div>
            </div>
            <div className="bg-[#161b22] border border-[#30363d] border-dashed rounded-md p-4 text-center">
              <span className="text-xs text-[#484f58]">Ask why this tool call failed. Results appear in Questions below.</span>
            </div>
          </div>
        )}

        {/* Investigation Q&A */}
        {state.questions.length > 0 && (
          <div className="space-y-3">
            <span className="text-[10px] text-[#484f58] font-mono uppercase tracking-wider block">
              Questions
            </span>
            {state.questions.map((qa, i) => (
              <div key={i} className="space-y-1">
                <div className="flex gap-2 items-start">
                  <span className="text-[#58a6ff] text-xs shrink-0">Q:</span>
                  <span className="text-xs text-[#8b949e] flex-1 min-w-0">{qa.question}</span>
                  <CopyButton text={qa.question} />
                </div>
                <div className="flex gap-2 ml-4 items-start">
                  <span className="text-[#3fb950] text-xs shrink-0">A:</span>
                  <div className="flex-1 min-w-0">
                    <MarkdownOrText text={qa.answer} />
                  </div>
                  <CopyButton text={qa.answer} />
                </div>
                {(qa.tokens || qa.latencyMs) && (
                  <div className="ml-4 flex items-center gap-2 text-[10px] text-[#484f58]">
                    {qa.latencyMs !== undefined && <span>{qa.latencyMs}ms</span>}
                    {qa.tokens && (
                      <>
                        <span>·</span>
                        <span className="text-[#3fb950]/70">↑{qa.tokens.input.toLocaleString()}</span>
                        <span className="text-[#58a6ff]/70">↓{qa.tokens.output.toLocaleString()}</span>
                      </>
                    )}
                    {qa.model && <><span>·</span><span>{qa.model}</span></>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Per-event Access Log */}
        {(event.data.fileAccess?.length || event.data.urlAccess?.length) ? (
          <div>
            <span className="text-[10px] text-[#484f58] font-mono uppercase tracking-wider block mb-2">
              Access Log
            </span>
            {event.data.fileAccess && event.data.fileAccess.length > 0 && (
              <div className="space-y-0.5 mb-2">
                {event.data.fileAccess.map((fa, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="font-semibold text-[10px] w-12 shrink-0" style={{
                      color: fa.operation === 'read' ? '#a78bfa' : fa.operation === 'wrote' ? '#3fb950' : fa.operation === 'edited' ? '#d29922' : '#f85149'
                    }}>
                      {fa.operation}
                    </span>
                    <span className="font-mono text-[#8b949e] truncate" title={fa.path}>{fa.path}</span>
                  </div>
                ))}
              </div>
            )}
            {event.data.urlAccess && event.data.urlAccess.length > 0 && (
              <div className="space-y-0.5">
                {event.data.urlAccess.map((ua, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="font-semibold text-[10px] text-[#58a6ff] w-12 shrink-0">URL</span>
                    <span className="font-mono text-[#8b949e] truncate" title={ua.url}>
                      {ua.url.length > 60 ? ua.url.slice(0, 60) + '...' : ua.url}
                    </span>
                    {ua.bytesIn != null && ua.bytesIn > 0 && (
                      <span className="text-[10px] text-[#484f58] shrink-0">
                        {ua.bytesIn < 1024 ? `${ua.bytesIn} B` : `${(ua.bytesIn / 1024).toFixed(1)} KB`}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* Ask question input */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono text-white uppercase">
              Ask a question
            </span>
            <button
              onClick={fetchModels}
              disabled={fetchingModels}
              className="text-[10px] text-[#58a6ff] hover:text-[#79c0ff] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {fetchingModels ? 'Fetching...' : '↻ Fetch models'}
            </button>
          </div>
          {availableModels.length > 0 ? (
            <select
              value={askModel}
              onChange={(e) => setAskModel(e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-[#8b949e] focus:outline-none focus:border-[#58a6ff] mb-2"
            >
              {!availableModels.includes(askModel) && askModel && (
                <option value={askModel}>{askModel}</option>
              )}
              {availableModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={askModel}
              onChange={(e) => setAskModel(e.target.value)}
              placeholder="Model (default from settings)"
              className="w-full px-3 py-1.5 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-[#8b949e] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] mb-2"
            />
          )}
          {fetchModelError && (
            <p className="text-[10px] text-[#f85149] mb-2">{fetchModelError}</p>
          )}
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
