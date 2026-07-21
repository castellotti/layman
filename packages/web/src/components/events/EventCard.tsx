import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { TimelineEvent, SubagentTranscriptEntry } from '../../lib/types.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import { ApprovalBar } from '../controls/ApprovalBar.js';
import { AnalysisCard } from '../analysis/AnalysisCard.js';
import { CodeBlock } from '../shared/CodeBlock.js';
import { DiffBlock } from '../shared/DiffBlock.js';
import { usePendingApprovals } from '../../hooks/usePendingApprovals.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { DRIFT_COLORS } from '../../lib/event-styles.js';
import { MARKDOWN_PROSE, REMARK_PLUGINS } from '../../lib/markdown.js';
import { getEffectiveAgentContent } from '../../lib/reasoning.js';

export { ThinkingBlock } from '../shared/ThinkingBlock.js';
import { ThinkingBlock } from '../shared/ThinkingBlock.js';

function formatToolInput(toolInput: Record<string, unknown>): string {
  // Special handling for Bash command
  if ('command' in toolInput) {
    return String(toolInput.command);
  }
  // File path tools
  if ('file_path' in toolInput) {
    const path = String(toolInput.file_path);
    if ('content' in toolInput) {
      return `${path}\n${String(toolInput.content).slice(0, 500)}`;
    }
    if ('old_string' in toolInput) {
      return `${path}\n- ${String(toolInput.old_string).slice(0, 100)}\n+ ${String(toolInput.new_string ?? '').slice(0, 100)}`;
    }
    return path;
  }
  // Pattern tools
  if ('pattern' in toolInput) {
    return String(toolInput.pattern);
  }
  if ('query' in toolInput) {
    return String(toolInput.query);
  }
  if ('url' in toolInput) {
    return String(toolInput.url);
  }
  if ('prompt' in toolInput) {
    return String(toolInput.prompt).slice(0, 200);
  }
  return JSON.stringify(toolInput, null, 2).slice(0, 500);
}

interface EventDetailBodyProps {
  event: TimelineEvent;
  onSend: (msg: ClientMessage) => void;
}

/**
 * The expanded detail content for a single event — tool input/output, diffs,
 * prompt/response, drift detail + approval controls, analysis, subagent
 * transcript. Extracted from the former EventCard's exchange-tree row so the
 * flat Logs single-line rows (LogRow) can reuse the exact same rich, per-type
 * rendering (including live Approve/Deny controls) inside the new card chrome.
 */
export function EventDetailBody({ event, onSend }: EventDetailBodyProps) {
  const [highlighting, setHighlighting] = useState(false);
  const { approvals } = usePendingApprovals();
  const highlightedEventIds = useSessionStore((s) => s.highlightedEventIds);

  const isHighlighted = highlightedEventIds.has(event.id);

  const isPending = event.type === 'tool_call_pending' || event.type === 'permission_request';
  const isAgentResponse = event.type === 'agent_response';
  const isWebSearch = event.type === 'web_search';

  const { thinking: effectiveThinking, response: agentResponse } = useMemo(
    () => getEffectiveAgentContent(event),
    [event.type, event.data.thinking, event.data.prompt]
  );
  const effectivePrompt = agentResponse.trim() ? agentResponse : undefined;
  const isUserPrompt = event.type === 'user_prompt';

  // Find matching pending approval
  const pendingApproval = isPending
    ? approvals.find(
        (a) => a.toolName === event.data.toolName && Math.abs(a.timestamp - event.timestamp) < 5000
      )
    : undefined;

  const handleHighlight = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (highlighting) return;
    setHighlighting(true);
    try {
      const { events: liveEvents, historicalEvents, highlights } = useSessionStore.getState();
      const eventList = historicalEvents.some((ev) => ev.id === event.id) ? historicalEvents : liveEvents;
      if (isHighlighted) {
        const existing = highlights.find((h) => h.promptEventId === event.id || h.responseEventId === event.id);
        if (existing) {
          await fetch(`/api/highlights/${existing.id}`, { method: 'DELETE' }).catch(() => {});
        }
      } else {
        let promptEventId: string;
        let responseEventId: string;
        let promptText = '';
        const trueIndex = eventList.findIndex((ev) => ev.id === event.id);
        if (isUserPrompt) {
          promptEventId = event.id;
          promptText = event.data.prompt ?? '';
          const nextResponse = eventList.slice(trueIndex + 1).find((ev) => ev.type === 'agent_response' && ev.sessionId === event.sessionId);
          responseEventId = nextResponse?.id ?? event.id;
        } else {
          responseEventId = event.id;
          let prevPrompt: typeof eventList[number] | undefined;
          for (let i = trueIndex - 1; i >= 0; i--) {
            if (eventList[i].type === 'user_prompt' && eventList[i].sessionId === event.sessionId) {
              prevPrompt = eventList[i];
              break;
            }
          }
          promptEventId = prevPrompt?.id ?? event.id;
          promptText = prevPrompt?.data.prompt ?? '';
        }
        const name = promptText.trim().slice(0, 60) || `Highlight ${new Date().toLocaleTimeString()}`;
        await fetch('/api/highlights', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: event.sessionId, promptEventId, responseEventId, name }),
        }).catch(() => {});
      }
    } finally {
      setHighlighting(false);
    }
  };

  return (
        <div className="px-3 py-3 space-y-2">
          {/* Tool input — diff view for Edit/Write, code (or CommandBlock for shell) otherwise */}
          {event.data.toolInput && (() => {
            const input = event.data.toolInput;
            const tool = event.data.toolName;

            if ((tool === 'Edit' || tool === 'MultiEdit') && 'old_string' in input) {
              return (
                <DiffBlock
                  filePath={String(input.file_path ?? '')}
                  oldText={String(input.old_string ?? '')}
                  newText={String(input.new_string ?? '')}
                  maxLines={30}
                />
              );
            }

            if (tool === 'Write' && 'content' in input) {
              return (
                <DiffBlock
                  filePath={String(input.file_path ?? '')}
                  addedText={String(input.content ?? '')}
                  maxLines={30}
                />
              );
            }

            const isShell = tool === 'Bash';
            return (
              <div>
                {!isShell && <p className="text-[10px] text-[var(--text-faint)] mb-1 font-mono uppercase">Input</p>}
                <CodeBlock
                  code={formatToolInput(input)}
                  language={isShell ? 'bash' : 'text'}
                  maxLines={10}
                  showWrapToggle
                />
              </div>
            );
          })()}

          {/* Permission request details */}
          {event.type === 'permission_request' && (event.data.permissionRequestType || event.data.permissionSuggestions) && (
            <div className="space-y-1.5">
              {event.data.permissionRequestType && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-[var(--text-faint)] font-mono uppercase">Permission type</span>
                  <span className="text-[10px] font-medium text-[var(--warn)] bg-[var(--warn)]/10 border border-[var(--warn)]/20 px-1.5 py-0.5 rounded">
                    {event.data.permissionRequestType === 'tool_use' ? 'Tool Use' : 'Execution Mode'}
                  </span>
                </div>
              )}
              {event.data.permissionSuggestions && event.data.permissionSuggestions.length > 0 && (
                <div>
                  <p className="text-[10px] text-[var(--text-faint)] mb-1 font-mono uppercase">Allow suggestions</p>
                  <div className="space-y-1">
                    {(event.data.permissionSuggestions as Array<Record<string, unknown>>).map((s, i) => (
                      <div key={i} className="text-[11px] text-[var(--text-muted)] bg-[var(--bg)] rounded px-2 py-1 font-mono">
                        {s.description ? String(s.description) : s.command ? String(s.command) : JSON.stringify(s)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Thinking blocks — agent_response only, collapsible */}
          {isAgentResponse && effectiveThinking && (
            <ThinkingBlock thinking={effectiveThinking} />
          )}

          {/* Prompt text — user_prompt and agent_response: markdown; others: plain */}
          {effectivePrompt && (
            (isAgentResponse || isUserPrompt) ? (
              <div className={`rounded-md border border-[var(--border-strong)] overflow-hidden`}>
                <div className="flex items-center justify-between px-3 py-1 bg-[var(--bg-card)] border-b border-[var(--border-strong)]">
                  <span className="text-[10px] text-[var(--text-faint)] font-mono uppercase">{isUserPrompt ? 'Prompt' : 'Response'}</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleHighlight}
                      disabled={highlighting}
                      className={`text-xs transition-colors ${isHighlighted ? 'text-[var(--agent)] opacity-80' : 'text-[var(--text-muted)] hover:text-[var(--agent)]'}`}
                      title={isHighlighted ? 'Remove highlight' : 'Highlight this prompt–response pair'}
                    >
                      {highlighting ? '…' : isHighlighted ? 'Highlighted' : 'Highlight'}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(effectivePrompt!).catch(() => {}); }}
                      className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                    >
                      Copy
                    </button>
                  </div>
                </div>
                <div className={`p-3 border-l-2 ${isUserPrompt ? 'border-[var(--accent)]' : 'border-[var(--ok)]/50'} ${MARKDOWN_PROSE}`}>
                  <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{effectivePrompt!}</ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-[var(--border-strong)] overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1 bg-[var(--bg-card)] border-b border-[var(--border-strong)]">
                  <span className="text-[10px] text-[var(--text-faint)] font-mono uppercase">Prompt</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(effectivePrompt!).catch(() => {}); }}
                    className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                  >
                    Copy
                  </button>
                </div>
                <pre className="p-3 text-xs text-[var(--text)] leading-relaxed whitespace-pre-wrap break-words font-sans border-l-2 border-[var(--accent)]">
                  {effectivePrompt!}
                </pre>
              </div>
            )
          )}

          {/* Error */}
          {event.data.error && (
            <div>
              <p className="text-[10px] text-[var(--error)] mb-1 font-mono uppercase">Error</p>
              <CodeBlock code={event.data.error} maxLines={15} className="border-[var(--error)]/30" />
            </div>
          )}

          {/* Tool output (for completed events) */}
          {event.data.toolOutput !== undefined && (
            <div>
              <p className="text-[10px] text-[var(--text-faint)] mb-1 font-mono uppercase">Output</p>
              <CodeBlock
                code={
                  typeof event.data.toolOutput === 'string'
                    ? event.data.toolOutput
                    : JSON.stringify(event.data.toolOutput, null, 2)
                }
                maxLines={8}
              />
            </div>
          )}

          {/* Denial reason */}
          {event.data.decision?.reason && (
            <p className="text-xs text-[var(--error)]">
              Reason: {event.data.decision.reason}
            </p>
          )}

          {/* Drift event details */}
          {(event.type === 'drift_check' || event.type === 'drift_alert') && (
            <DriftDetailSection event={event} onSend={onSend} />
          )}

          {/* Drift alert approval controls */}
          {event.type === 'drift_alert' && !event.data.decision && (() => {
            const driftApproval = approvals.find((a) => a.isDriftBlock);
            if (!driftApproval) return null;
            return (
              <DriftApprovalBar
                approvalId={driftApproval.id}
                sessionId={event.sessionId}
                onSend={onSend}
              />
            );
          })()}

          {/* Web search sources */}
          {isWebSearch && (
            <div className="space-y-2">
              {event.data.webSearchQueries && event.data.webSearchQueries.length > 0 && (
                <div>
                  <p className="text-[10px] text-[var(--text-faint)] mb-1.5 font-mono uppercase">Queries</p>
                  <div className="flex flex-wrap gap-1.5">
                    {event.data.webSearchQueries.map((q, i) => (
                      <span
                        key={i}
                        className="text-[11px] text-[var(--accent)] bg-[var(--accent)]/10 border border-[var(--accent)]/20 px-2 py-0.5 rounded font-mono"
                      >
                        {q}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {event.data.webSearchSources && event.data.webSearchSources.length > 0 && (
                <div>
                  <p className="text-[10px] text-[var(--text-faint)] mb-1.5 font-mono uppercase">
                    Retrieved sources
                  </p>
                  <div className="space-y-1.5">
                    {event.data.webSearchSources.map((src, i) => (
                      <a
                        key={i}
                        href={src.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="flex flex-col gap-0.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 hover:border-[var(--accent)]/40 hover:bg-[var(--accent)]/5 transition-colors group"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-[var(--accent)] bg-[var(--accent)]/10 border border-[var(--accent)]/20 px-1.5 py-0.5 rounded font-mono shrink-0">
                            {src.hostname}
                          </span>
                          <span className="text-[11px] text-[var(--text)] font-medium truncate group-hover:text-[var(--accent)] transition-colors">
                            {src.title}
                          </span>
                        </div>
                        <span className="text-[10px] text-[var(--text-faint)] font-mono truncate pl-0.5">
                          {src.url}
                        </span>
                        {src.content && (
                          <p className="text-[11px] text-[var(--text-muted)] mt-0.5 line-clamp-2 leading-relaxed">
                            {src.content}
                          </p>
                        )}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {event.type === 'subagent_stop' && event.data.subagentTranscript && event.data.subagentTranscript.length > 0 && (
            <SubagentTranscriptView entries={event.data.subagentTranscript} />
          )}

          {/* Analysis card */}
          {event.analysis && (
            <div className="bg-[var(--bg)] border border-[var(--border-strong)] rounded-md p-3">
              <p className="text-[10px] text-[var(--text-faint)] font-mono uppercase mb-2">Analysis</p>
              <AnalysisCard analysis={event.analysis} compact />
            </div>
          )}

          {/* Approval bar — only for tool call approvals, not permission prompts */}
          {event.type === 'tool_call_pending' && pendingApproval && !event.data.decision && (
            <div className="pt-1">
              <ApprovalBar
                approvalId={pendingApproval.id}
                toolName={pendingApproval.toolName}
                onSend={onSend}
              />
            </div>
          )}
        </div>
  );
}

function DriftApprovalBar({
  approvalId,
  sessionId,
  onSend,
}: {
  approvalId: string;
  sessionId: string;
  onSend: (msg: ClientMessage) => void;
}) {
  const [decided, setDecided] = useState(false);

  if (decided) {
    return <div className="text-xs text-[var(--text-muted)] italic pt-1">Decision sent — waiting for agent to continue...</div>;
  }

  const handleContinue = () => {
    setDecided(true);
    onSend({ type: 'approval:decide', approvalId, decision: { decision: 'allow' } });
  };

  const handleDismiss = () => {
    setDecided(true);
    onSend({ type: 'drift:dismiss', sessionId, approvalId });
  };

  const handleDeny = () => {
    setDecided(true);
    onSend({ type: 'approval:decide', approvalId, decision: { decision: 'deny', reason: 'Drift threshold exceeded' } });
  };

  return (
    <div className="pt-2 space-y-2">
      <div className="flex gap-2">
        <button
          onClick={handleContinue}
          className="flex-1 px-3 py-2 text-xs font-semibold rounded-md bg-[var(--ok)] hover:bg-[var(--ok)] text-white transition-colors border border-[var(--ok)]/30"
        >
          Continue
        </button>
        <button
          onClick={handleDismiss}
          className="flex-1 px-3 py-2 text-xs font-semibold rounded-md transition-colors border"
          style={{
            background: 'rgba(210, 153, 34, 0.15)',
            borderColor: 'rgba(210, 153, 34, 0.3)',
            color: 'var(--warn)',
          }}
        >
          Dismiss as False Positive
        </button>
        <button
          onClick={handleDeny}
          className="flex-1 px-3 py-2 text-xs font-semibold rounded-md bg-[var(--error)]/20 hover:bg-[var(--error)]/30 text-[var(--error)] transition-colors border border-[var(--error)]/30"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function DismissItemButton({
  sessionId,
  category,
  value,
  onSend,
}: {
  sessionId: string;
  category: 'indicator' | 'patternBreak' | 'phantomReference' | 'violation';
  value: string;
  onSend: (msg: ClientMessage) => void;
}) {
  return (
    <button
      className="ml-auto text-[var(--text-faint)] hover:text-[var(--text-muted)] text-[10px] shrink-0 px-1"
      onClick={(e) => {
        e.stopPropagation();
        onSend({ type: 'drift:dismiss-item', sessionId, category, value });
      }}
      title="Dismiss as false positive"
    >
      &times;
    </button>
  );
}

function DriftDetailSection({
  event,
  onSend,
}: {
  event: TimelineEvent;
  onSend: (msg: ClientMessage) => void;
}) {
  const dismissed = useSessionStore((s) => s.driftState.get(event.sessionId)?.dismissedItems);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
          event.data.driftType === 'rules'
            ? 'bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20'
            : 'bg-[var(--warn)]/10 text-[var(--warn)] border border-[var(--warn)]/20'
        }`}>
          {event.data.driftType === 'rules' ? 'RULES DRIFT' : 'SESSION DRIFT'}
        </span>
        <span className="text-xs font-mono font-semibold" style={{ color: DRIFT_COLORS[event.data.driftLevel ?? 'red'] }}>
          {Math.round(event.data.driftPct ?? 0)}%
        </span>
        {event.data.driftPreviousLevel && event.data.driftPreviousLevel !== event.data.driftLevel && (
          <span className="text-[10px] text-[var(--text-muted)]">
            {event.data.driftPreviousLevel} → {event.data.driftLevel}
          </span>
        )}
      </div>
      {event.data.driftSummary && (
        <p className="text-xs text-[var(--text)] leading-relaxed">{event.data.driftSummary}</p>
      )}
      {event.data.driftIndicators && event.data.driftIndicators.length > 0 && (
        <div>
          <p className="text-[10px] text-[var(--text-faint)] font-mono uppercase mb-1">Indicators</p>
          <ul className="space-y-0.5">
            {event.data.driftIndicators.map((ind, i) => {
              const isDismissed = dismissed?.indicators?.includes(ind);
              return (
                <li key={i} className={`text-[11px] flex items-start gap-1.5 ${isDismissed ? 'line-through opacity-40' : 'text-[var(--text-muted)]'}`}>
                  <span className="text-[var(--warn)] mt-0.5 shrink-0">&#8226;</span>
                  <span className="flex-1">{ind}</span>
                  {!isDismissed && <DismissItemButton sessionId={event.sessionId} category="indicator" value={ind} onSend={onSend} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {event.data.driftViolations && event.data.driftViolations.length > 0 && (
        <div>
          <p className="text-[10px] text-[var(--text-faint)] font-mono uppercase mb-1">Violations</p>
          <div className="space-y-1">
            {event.data.driftViolations.map((v, i) => {
              const isDismissed = dismissed?.violations?.includes(v.rule);
              return (
                <div key={i} className={`text-[11px] bg-[var(--bg)] rounded px-2 py-1 border border-[var(--border-strong)] flex items-center ${isDismissed ? 'line-through opacity-40' : ''}`}>
                  <span className="flex-1">
                    <span className={`font-medium ${
                      v.severity === 'critical' ? 'text-[var(--error)]' : v.severity === 'major' ? 'text-[#ff9100]' : 'text-[#ffb300]'
                    }`}>{v.severity}</span>
                    <span className="text-[var(--text-faint)] mx-1">|</span>
                    <span className="text-[var(--text-muted)]">{v.rule}</span>
                    <span className="text-[var(--text-faint)] mx-1">&rarr;</span>
                    <span className="text-[var(--text)]">{v.action}</span>
                  </span>
                  {!isDismissed && <DismissItemButton sessionId={event.sessionId} category="violation" value={v.rule} onSend={onSend} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {event.data.driftPhantomRefs && event.data.driftPhantomRefs.length > 0 && (
        <div>
          <p className="text-[10px] text-[var(--text-faint)] font-mono uppercase mb-1">Phantom references</p>
          <ul className="space-y-0.5">
            {event.data.driftPhantomRefs.map((ref, i) => {
              const isDismissed = dismissed?.phantomReferences?.includes(ref);
              return (
                <li key={i} className={`text-[11px] font-mono flex items-start gap-1.5 ${isDismissed ? 'line-through opacity-40' : 'text-[var(--error)]'}`}>
                  <span className="flex-1">{ref}</span>
                  {!isDismissed && <DismissItemButton sessionId={event.sessionId} category="phantomReference" value={ref} onSend={onSend} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {event.data.driftPatternBreaks && event.data.driftPatternBreaks.length > 0 && (
        <div>
          <p className="text-[10px] text-[var(--text-faint)] font-mono uppercase mb-1">Pattern breaks</p>
          <ul className="space-y-0.5">
            {event.data.driftPatternBreaks.map((pb, i) => {
              const isDismissed = dismissed?.patternBreaks?.includes(pb);
              return (
                <li key={i} className={`text-[11px] flex items-start gap-1.5 ${isDismissed ? 'line-through opacity-40' : 'text-[var(--text-muted)]'}`}>
                  <span className="text-[#ff9100] mt-0.5 shrink-0">&#8226;</span>
                  <span className="flex-1">{pb}</span>
                  {!isDismissed && <DismissItemButton sessionId={event.sessionId} category="patternBreak" value={pb} onSend={onSend} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function getInputPreview(inp: Record<string, unknown>): string | null {
  return (inp.command as string | undefined)
    ?? (inp.file_path as string | undefined)
    ?? (inp.url as string | undefined)
    ?? (inp.query as string | undefined)
    ?? (inp.prompt as string | undefined)
    ?? null;
}

function SubagentTranscriptView({ entries }: { entries: SubagentTranscriptEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const toolCount = entries.filter(e => e.role === 'tool').length;

  return (
    <div className="rounded-md border border-[var(--border-strong)] overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-card)] hover:bg-[var(--bg-selected)] transition-colors text-left"
        onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
      >
        <span className="text-[10px] text-[var(--text-faint)] font-mono uppercase">Sub-agent transcript</span>
        <span className="text-[10px] text-[var(--accent)] bg-[var(--accent)]/10 border border-[var(--accent)]/20 px-1.5 py-0.5 rounded font-mono">
          {toolCount} {toolCount === 1 ? 'call' : 'calls'}
        </span>
        <span className="ml-auto text-[var(--text-faint)] text-[10px]">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="divide-y divide-[var(--border-strong)]/50 bg-[var(--bg)]">
          {entries.map((entry, i) => (
            <div key={i} className="px-3 py-2 space-y-1">
              {entry.role === 'assistant' && entry.text && (
                <p className="text-[11px] text-[var(--text-muted)] italic leading-relaxed">{entry.text}</p>
              )}
              {entry.role === 'tool' && entry.toolName && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-[var(--ok)] font-mono font-semibold">{entry.toolName}</span>
                    {entry.toolInput && (() => {
                      const preview = getInputPreview(entry.toolInput);
                      return preview ? (
                        <span className="text-[11px] text-[var(--text)] font-mono truncate">{String(preview).slice(0, 80)}</span>
                      ) : null;
                    })()}
                  </div>
                  {entry.toolOutput !== undefined && (
                    <CodeBlock
                      code={typeof entry.toolOutput === 'string' ? entry.toolOutput : JSON.stringify(entry.toolOutput, null, 2)}
                      maxLines={5}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
