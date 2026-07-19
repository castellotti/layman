import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { useSessionStore } from '../../stores/sessionStore.js';
import { useEventStore } from '../../hooks/useEventStore.js';
import { AnalysisCard } from '../analysis/AnalysisCard.js';
import { AskQuestion } from '../analysis/AskQuestion.js';
import { RiskBadge } from '../shared/RiskBadge.js';
import { CodeBlock } from '../shared/CodeBlock.js';
import { isMarkdown, MARKDOWN_PROSE, REMARK_PLUGINS } from '../../lib/markdown.js';
import { getEffectiveAgentContent } from '../../lib/reasoning.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import type { TimelineEvent } from '../../lib/types.js';
import { ThinkingBlock } from '../shared/ThinkingBlock.js';

type AskPhase = 'connecting' | 'waiting';

function AgentResponsePrompt({ event }: { event: TimelineEvent }) {
  const { thinking, response } = getEffectiveAgentContent(event);
  return (
    <>
      {thinking && <div className="mb-2"><ThinkingBlock thinking={thinking} /></div>}
      {response && (
        <div className="bg-[#0d1117] border border-[#30363d] rounded-md overflow-hidden">
          <div className="flex items-center justify-end px-3 py-1 border-b border-[#30363d]">
            <CopyButton text={response} />
          </div>
          <div className="px-3 py-2 border-l-2 border-[#58a6ff]">
            <MarkdownOrText text={response} />
          </div>
        </div>
      )}
    </>
  );
}

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
  /** 'docked' renders inline as a panel column; 'drawer' renders as a right slide-over
   *  (used when the expanding layout doesn't have room to dock Investigation — §1.5). */
  presentation?: 'docked' | 'drawer';
}

export function InvestigationPanel({ onSend, eventId: embeddedEventId, onClose, presentation = 'docked' }: InvestigationPanelProps) {
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
  const [activeTab, setActiveTab] = useState<'explain' | 'chat'>('explain');
  const [isAskingQuestion, setIsAskingQuestion] = useState(false);
  const [askModel, setAskModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchModelError, setFetchModelError] = useState<string | null>(null);
  const [laymansDepth, setLaymansDepth] = useState<'quick' | 'detailed' | null>(null);
  const [analysisDepth, setAnalysisDepth] = useState<'quick' | 'detailed' | null>(null);
  const [isAskingFailure, setIsAskingFailure] = useState(false);

  const [pendingAsk, setPendingAsk] = useState<{
    question: string;
    phase: AskPhase;
    startedAt: number;
    elapsedMs: number;
  } | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPendingTimer = useCallback((question: string) => {
    const startedAt = Date.now();
    setPendingAsk({ question, phase: 'connecting', startedAt, elapsedMs: 0 });
    if (pendingTimerRef.current) clearInterval(pendingTimerRef.current);
    pendingTimerRef.current = setInterval(() => {
      setPendingAsk((prev) => {
        if (!prev) return null;
        const elapsed = Date.now() - prev.startedAt;
        return { ...prev, elapsedMs: elapsed, phase: elapsed > 800 ? 'waiting' : 'connecting' };
      });
    }, 200);
  }, []);

  const clearPendingTimer = useCallback(() => {
    if (pendingTimerRef.current) {
      clearInterval(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  }, []);

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

  // Auto-fetch the model list once on mount so the header selector is populated without
  // requiring a manual refresh click.
  useEffect(() => {
    if (config && availableModels.length === 0 && !fetchingModels) {
      void fetchModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // Reset depth tracking when navigating to a different event
  useEffect(() => {
    setLaymansDepth(null);
    setAnalysisDepth(null);
  }, [selectedEventId]);

  // Cancel the tick timer when the panel unmounts
  useEffect(() => () => clearPendingTimer(), [clearPendingTimer]);

  // ESC closes the drawer (before any other ESC-bound behavior elsewhere in the app)
  useEffect(() => {
    if (presentation !== 'drawer') return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (onClose) onClose(); else setInvestigationOpen(false);
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [presentation, onClose, setInvestigationOpen]);

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
    onSend({ type: 'analysis:request', eventId: selectedEventId, depth, ...(askModel ? { model: askModel } : {}) });
  };

  const handleRequestLaymans = (depth: 'quick' | 'detailed') => {
    setLaymansDepth(depth);
    markSessionInvestigated(event.sessionId);
    onSend({ type: 'laymans:request', eventId: selectedEventId, depth, ...(askModel ? { model: askModel } : {}) });
  };

  const handleRequestBoth = (depth: 'quick' | 'detailed') => {
    setLaymansDepth(depth);
    setAnalysisDepth(depth);
    markSessionInvestigated(event.sessionId);
    onSend({ type: 'both:request', eventId: selectedEventId, depth, ...(askModel ? { model: askModel } : {}) });
  };

  const handleAskWhyFailed = async (depth: 'quick' | 'detailed') => {
    const question = depth === 'quick'
      ? 'Why did this tool call fail and what was wrong?'
      : 'Why did this tool call fail? What was wrong with the approach, what error occurred, and what was the eventual solution or workaround? Provide a detailed analysis.';
    markSessionInvestigated(event.sessionId);
    setIsAskingFailure(true);
    startPendingTimer(question);
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
        const answer = data.answer?.trim();
        addInvestigationQuestion(selectedEventId, question,
          answer || '[The model returned a blank response.]',
          { tokens: data.tokens, latencyMs: data.latencyMs, model: data.model });
      } else {
        addInvestigationQuestion(selectedEventId, question, `Request failed (HTTP ${response.status}). Please try again.`);
      }
    } catch (err) {
      addInvestigationQuestion(selectedEventId, question,
        `Network error: ${err instanceof Error ? err.message : 'Could not reach the server.'}`);
    } finally {
      clearPendingTimer();
      setPendingAsk(null);
      setIsAskingFailure(false);
    }
  };

  const handleAsk = async (question: string) => {
    markSessionInvestigated(event.sessionId);
    setIsAskingQuestion(true);
    startPendingTimer(question);
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
        const answer = data.answer?.trim();
        const finalAnswer = answer
          ? answer
          : '[The model returned a blank response. This may indicate a token limit was reached, the model refused to answer, or a provider-side issue occurred.]';
        addInvestigationQuestion(selectedEventId, question, finalAnswer, {
          tokens: data.tokens,
          latencyMs: data.latencyMs,
          model: data.model,
        });
      } else {
        const errData = await response.json().catch(() => ({})) as { error?: string };
        addInvestigationQuestion(selectedEventId, question,
          `Request failed (HTTP ${response.status})${errData.error ? `: ${errData.error}` : '. Please try again.'}`);
      }
    } catch (err) {
      addInvestigationQuestion(selectedEventId, question,
        `Network error: ${err instanceof Error ? err.message : 'Could not reach the server. Please try again.'}`);
    } finally {
      clearPendingTimer();
      setPendingAsk(null);
      setIsAskingQuestion(false);
    }
  };

  const formatInput = (input: Record<string, unknown>): string => {
    if ('command' in input) return String(input.command);
    return JSON.stringify(input, null, 2);
  };

  const closeDrawer = () => { if (onClose) onClose(); else setInvestigationOpen(false); };

  const panelContent = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderLeft: presentation === 'docked' ? '1px solid var(--border)' : 'none', background: 'var(--bg)' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-raised)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
            Investigation
          </span>
          {event.riskLevel && <RiskBadge level={event.riskLevel} compact />}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>
            {event.type.replace(/_/g, ' ')}
            {event.data.toolName ? ` · ${event.data.toolName}` : ''}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Quick combo button */}
          <button
            onClick={() => handleRequestBoth('quick')}
            disabled={isBusy}
            style={{
              padding: '3px 9px', fontSize: 10, borderRadius: 4, fontFamily: 'var(--font-ui)',
              fontWeight: 500, cursor: isBusy ? 'not-allowed' : 'pointer', opacity: isBusy ? 0.5 : 1,
              background: 'rgba(76,195,138,0.15)', color: 'var(--ok)',
              border: '1px solid rgba(76,195,138,0.3)',
            }}
          >
            {isBusy ? '⏳' : '⚡'} Quick
          </button>
          {/* Detailed combo button */}
          <button
            onClick={() => handleRequestBoth('detailed')}
            disabled={isBusy}
            style={{
              padding: '3px 9px', fontSize: 10, borderRadius: 4, fontFamily: 'var(--font-ui)',
              fontWeight: 500, cursor: isBusy ? 'not-allowed' : 'pointer', opacity: isBusy ? 0.5 : 1,
              background: 'rgba(90,156,248,0.12)', color: 'var(--info)',
              border: '1px solid rgba(90,156,248,0.25)',
            }}
          >
            {isBusy ? '⏳' : '🔍'} Detailed
          </button>
          {/* Compact model selector — overrides the model for Explain (laymans/analysis) and Chat */}
          <select
            value={askModel}
            onChange={(e) => setAskModel(e.target.value)}
            title="Analysis model — applies to Explain and Chat"
            style={{
              maxWidth: 100, padding: '2px 4px', fontSize: 10,
              fontFamily: 'var(--font-mono)', background: 'var(--bg-card)',
              border: '1px solid var(--border-strong)', borderRadius: 4,
              color: 'var(--text-body)', outline: 'none', cursor: 'pointer',
            }}
          >
            {askModel && !availableModels.includes(askModel) && (
              <option value={askModel}>{askModel}</option>
            )}
            {availableModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <button
            onClick={() => { if (onClose) onClose(); else setInvestigationOpen(false); }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: 18, lineHeight: 1, padding: '0 2px',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
          >
            ×
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 2, padding: '6px 14px 0', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {(['explain', 'chat'] as const).map((tab) => {
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '7px 12px', fontSize: 11.5, fontFamily: 'var(--font-ui)',
                border: 'none', borderRadius: '5px 5px 0 0', cursor: 'pointer',
                background: active ? 'var(--bg-selected)' : 'transparent',
                color: active ? 'var(--text)' : 'var(--text-muted)',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                fontWeight: active ? 600 : 400,
                textTransform: 'capitalize',
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = 'var(--text)'; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              {tab}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* CONTEXT indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>
          <span style={{ color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.06em' }}>CONTEXT</span>
          <span>full session · selected item first</span>
        </div>

        {activeTab === 'explain' && <>
        {/* INPUT section */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Input</span>
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

          {event.data.prompt && <AgentResponsePrompt event={event} />}
        </div>

        {/* LAYMAN'S TERMS section */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text)' }}>
              Layman&apos;s Terms
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={() => handleRequestLaymans('quick')}
                disabled={isLaymansLoading}
                style={{
                  fontSize: 10, background: 'none', border: 'none', cursor: isLaymansLoading ? 'not-allowed' : 'pointer',
                  opacity: isLaymansLoading ? 0.5 : 1,
                  color: event.laymans && laymansDepth === 'quick' ? 'var(--text)' : 'var(--ok)',
                  fontWeight: event.laymans && laymansDepth === 'quick' ? 600 : 400,
                  fontFamily: 'var(--font-ui)',
                }}
              >
                {isLaymansLoading && laymansDepth === 'quick' ? '⏳ Explaining...' : 'Quick'}
              </button>
              <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>·</span>
              <button
                onClick={() => handleRequestLaymans('detailed')}
                disabled={isLaymansLoading}
                style={{
                  fontSize: 10, background: 'none', border: 'none', cursor: isLaymansLoading ? 'not-allowed' : 'pointer',
                  opacity: isLaymansLoading ? 0.5 : 1,
                  color: event.laymans && laymansDepth === 'detailed' ? 'var(--text)' : 'var(--info)',
                  fontWeight: event.laymans && laymansDepth === 'detailed' ? 600 : 400,
                  fontFamily: 'var(--font-ui)',
                }}
              >
                {isLaymansLoading && laymansDepth === 'detailed' ? '⏳ Explaining...' : 'Detailed'}
              </button>
            </div>
          </div>

          {event.laymans ? (
            <div style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <MarkdownOrText text={event.laymans.explanation} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 6, borderTop: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>
                {event.laymans.latencyMs !== undefined && <span>{event.laymans.latencyMs}ms</span>}
                {event.laymans.tokens && (
                  <>
                    <span>·</span>
                    <span style={{ color: 'rgba(76,195,138,0.7)' }}>↑{event.laymans.tokens.input.toLocaleString()}</span>
                    <span style={{ color: 'rgba(90,156,248,0.7)' }}>↓{event.laymans.tokens.output.toLocaleString()}</span>
                  </>
                )}
                {event.laymans.model && <><span>·</span><span>{event.laymans.model}</span></>}
              </div>
            </div>
          ) : isLaymansLoading ? (
            <div style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px', textAlign: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)' }}>Explaining in plain language…</span>
            </div>
          ) : laymansError ? (
            <div style={{ background: 'var(--bg-raised)', border: '1px solid rgba(240,86,74,0.4)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--error)', fontFamily: 'var(--font-ui)' }}>Explanation failed</span>
              <p style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all', margin: 0 }}>{laymansError}</p>
            </div>
          ) : (
            <div style={{
              background: 'var(--bg-raised)', border: '1px dashed var(--border-strong)', borderRadius: 8,
              padding: '16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-ui)', fontStyle: 'italic' }}>
                Explain this request in plain language
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => handleRequestLaymans('quick')}
                  disabled={isLaymansLoading}
                  style={{
                    padding: '4px 10px', borderRadius: 4, fontSize: 10, fontFamily: 'var(--font-ui)',
                    background: 'var(--bg-card)', border: '1px solid var(--border-strong)',
                    color: 'var(--text-muted)', cursor: 'pointer',
                  }}
                >⚡ Quick</button>
                <button
                  onClick={() => handleRequestLaymans('detailed')}
                  disabled={isLaymansLoading}
                  style={{
                    padding: '4px 10px', borderRadius: 4, fontSize: 10, fontFamily: 'var(--font-ui)',
                    background: 'var(--bg-card)', border: '1px solid var(--border-strong)',
                    color: 'var(--text-muted)', cursor: 'pointer',
                  }}
                >Detailed</button>
              </div>
            </div>
          )}
        </div>

        {/* ANALYSIS section */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
              Analysis
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={() => handleRequestAnalysis('quick')}
                disabled={isAnalyzing}
                style={{
                  fontSize: 10, background: 'none', border: 'none', cursor: isAnalyzing ? 'not-allowed' : 'pointer',
                  opacity: isAnalyzing ? 0.5 : 1,
                  color: event.analysis && analysisDepth === 'quick' ? 'var(--text)' : 'var(--ok)',
                  fontWeight: event.analysis && analysisDepth === 'quick' ? 600 : 400,
                  fontFamily: 'var(--font-ui)',
                }}
              >
                {isAnalyzing && analysisDepth === 'quick' ? '⏳ Analyzing...' : 'Quick'}
              </button>
              <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>·</span>
              <button
                onClick={() => handleRequestAnalysis('detailed')}
                disabled={isAnalyzing}
                style={{
                  fontSize: 10, background: 'none', border: 'none', cursor: isAnalyzing ? 'not-allowed' : 'pointer',
                  opacity: isAnalyzing ? 0.5 : 1,
                  color: event.analysis && analysisDepth === 'detailed' ? 'var(--text)' : 'var(--info)',
                  fontWeight: event.analysis && analysisDepth === 'detailed' ? 600 : 400,
                  fontFamily: 'var(--font-ui)',
                }}
              >
                {isAnalyzing && analysisDepth === 'detailed' ? '⏳ Analyzing...' : 'Detailed'}
              </button>
            </div>
          </div>

          {event.analysis ? (
            <div style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
              <AnalysisCard analysis={event.analysis} />
            </div>
          ) : isAnalyzing ? (
            <div style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px', textAlign: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)' }}>Analyzing with LLM…</span>
            </div>
          ) : state.analysisError ? (
            <div style={{ background: 'var(--bg-raised)', border: '1px solid rgba(240,86,74,0.4)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--error)', fontFamily: 'var(--font-ui)' }}>Analysis failed</span>
              <p style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all', margin: 0 }}>{state.analysisError}</p>
              <p style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-ui)', margin: '4px 0 0 0' }}>
                Check Settings → Analysis Model. If using a local model, verify the endpoint is reachable.
              </p>
            </div>
          ) : (
            <div style={{
              background: 'var(--bg-raised)', border: '1px dashed var(--border-strong)', borderRadius: 8,
              padding: '16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-ui)' }}>
                Analyze intent, safety, and risk
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => handleRequestAnalysis('quick')}
                  disabled={isAnalyzing}
                  style={{
                    padding: '4px 10px', borderRadius: 4, fontSize: 10, fontFamily: 'var(--font-ui)',
                    background: 'var(--bg-card)', border: '1px solid var(--border-strong)',
                    color: 'var(--text-muted)', cursor: 'pointer',
                  }}
                >⚡ Quick</button>
                <button
                  onClick={() => handleRequestAnalysis('detailed')}
                  disabled={isAnalyzing}
                  style={{
                    padding: '4px 10px', borderRadius: 4, fontSize: 10, fontFamily: 'var(--font-ui)',
                    background: 'var(--bg-card)', border: '1px solid var(--border-strong)',
                    color: 'var(--text-muted)', cursor: 'pointer',
                  }}
                >Detailed</button>
              </div>
            </div>
          )}
        </div>

        {/* Failure Analysis section — only for tool_call_failed events */}
        {event.type === 'tool_call_failed' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--error)' }}>
                Failure Analysis
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  onClick={() => void handleAskWhyFailed('quick')}
                  disabled={isAskingFailure || isAskingQuestion}
                  style={{ fontSize: 10, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ok)', fontFamily: 'var(--font-ui)', opacity: (isAskingFailure || isAskingQuestion) ? 0.5 : 1 }}
                >
                  {isAskingFailure ? '⏳ Analyzing...' : 'Quick'}
                </button>
                <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>·</span>
                <button
                  onClick={() => void handleAskWhyFailed('detailed')}
                  disabled={isAskingFailure || isAskingQuestion}
                  style={{ fontSize: 10, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--info)', fontFamily: 'var(--font-ui)', opacity: (isAskingFailure || isAskingQuestion) ? 0.5 : 1 }}
                >
                  Detailed
                </button>
              </div>
            </div>
            <div style={{
              background: 'var(--bg-raised)', border: '1px dashed var(--border-strong)', borderRadius: 8,
              padding: '12px', textAlign: 'center',
            }}>
              <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-ui)' }}>
                Ask why this tool call failed. Results appear in Chat.
              </span>
            </div>
          </div>
        )}
        </>}

        {activeTab === 'chat' && <>
        {/* Investigation Q&A */}
        {(state.questions.length > 0 || pendingAsk) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
              Questions
            </span>
            {pendingAsk && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8, background: 'var(--bg-raised)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--info)', fontSize: 11, flexShrink: 0, fontFamily: 'var(--font-mono)' }}>Q:</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, minWidth: 0, fontFamily: 'var(--font-ui)' }}>{pendingAsk.question}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginLeft: 16, alignItems: 'center' }}>
                  <span style={{ color: 'var(--ok)', fontSize: 11, flexShrink: 0, fontFamily: 'var(--font-mono)' }}>A:</span>
                  <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
                    {pendingAsk.phase === 'connecting' ? 'Connecting…' : 'Waiting for response…'}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
                    {(pendingAsk.elapsedMs / 1000).toFixed(1)}s
                  </span>
                </div>
              </div>
            )}

            {state.questions.map((qa, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--info)', fontSize: 11, flexShrink: 0, fontFamily: 'var(--font-mono)' }}>Q:</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, minWidth: 0, fontFamily: 'var(--font-ui)' }}>{qa.question}</span>
                  <CopyButton text={qa.question} />
                </div>
                <div style={{ display: 'flex', gap: 8, marginLeft: 16, alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--ok)', fontSize: 11, flexShrink: 0, fontFamily: 'var(--font-mono)' }}>A:</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <MarkdownOrText text={qa.answer} />
                  </div>
                  <CopyButton text={qa.answer} />
                </div>
                {(qa.tokens || qa.latencyMs) && (
                  <div style={{ marginLeft: 16, display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>
                    {qa.latencyMs !== undefined && <span>{qa.latencyMs}ms</span>}
                    {qa.tokens && (
                      <>
                        <span>·</span>
                        <span style={{ color: 'rgba(76,195,138,0.7)' }}>↑{qa.tokens.input.toLocaleString()}</span>
                        <span style={{ color: 'rgba(90,156,248,0.7)' }}>↓{qa.tokens.output.toLocaleString()}</span>
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
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)', display: 'block', marginBottom: 8 }}>
              Access Log
            </span>
            {event.data.fileAccess && event.data.fileAccess.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 6 }}>
                {event.data.fileAccess.map((fa, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontWeight: 600, fontSize: 10, width: 48, flexShrink: 0, fontFamily: 'var(--font-mono)',
                      color: fa.operation === 'read' ? 'var(--agent)' : fa.operation === 'wrote' ? 'var(--ok)' : fa.operation === 'edited' ? 'var(--warn)' : 'var(--error)',
                    }}>
                      {fa.operation}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fa.path}>{fa.path}</span>
                  </div>
                ))}
              </div>
            )}
            {event.data.urlAccess && event.data.urlAccess.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {event.data.urlAccess.map((ua, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 10, color: 'var(--info)', width: 48, flexShrink: 0, fontFamily: 'var(--font-mono)' }}>URL</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }} title={ua.url}>
                      {ua.url.length > 60 ? ua.url.slice(0, 60) + '…' : ua.url}
                    </span>
                    {ua.bytesIn != null && ua.bytesIn > 0 && (
                      <span style={{ fontSize: 10, color: 'var(--text-faint)', flexShrink: 0, fontFamily: 'var(--font-mono)' }}>
                        {ua.bytesIn < 1024 ? `${ua.bytesIn} B` : `${(ua.bytesIn / 1024).toFixed(1)} KB`}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* ASK A QUESTION section */}
        <div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)', display: 'block', marginBottom: 8 }}>
            Ask a question
          </span>
          {fetchModelError && (
            <p style={{ fontSize: 10, color: 'var(--error)', fontFamily: 'var(--font-ui)', marginBottom: 8, margin: '0 0 8px 0' }}>{fetchModelError}</p>
          )}
          <AskQuestion
            eventId={selectedEventId}
            onAsk={handleAsk}
            isLoading={isAskingQuestion}
          />
        </div>
        </>}
      </div>
    </div>
  );

  if (presentation === 'drawer') {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 45, display: 'flex', justifyContent: 'flex-end' }}>
        <div
          onClick={closeDrawer}
          style={{ position: 'absolute', inset: 0, background: 'rgba(4,6,10,0.55)', animation: 'fadeIn 0.2s ease' }}
        />
        <div
          style={{
            position: 'relative',
            width: 480,
            maxWidth: '90vw',
            height: '100%',
            background: 'var(--bg)',
            borderLeft: '1px solid var(--border-strong)',
            boxShadow: '-16px 0 40px rgba(0,0,0,0.5)',
            animation: 'drawerIn 0.22s ease',
          }}
        >
          {panelContent}
        </div>
      </div>
    );
  }

  return panelContent;
}
