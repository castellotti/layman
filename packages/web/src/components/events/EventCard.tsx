import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { TimelineEvent } from '../../lib/types.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import { RiskBadge } from '../shared/RiskBadge.js';
import { ApprovalBar } from '../controls/ApprovalBar.js';
import { AnalysisCard } from '../analysis/AnalysisCard.js';
import { CodeBlock } from '../shared/CodeBlock.js';
import { DiffBlock } from '../shared/DiffBlock.js';
import { usePendingApprovals } from '../../hooks/usePendingApprovals.js';
import { useSessionStore } from '../../stores/sessionStore.js';

interface EventCardProps {
  event: TimelineEvent;
  index: number;
  isSelected: boolean;
  onClick: () => void;
  onSend: (msg: ClientMessage) => void;
  collapseHistory: boolean;
  showAgentBadge?: boolean;
}

import { AGENT_BADGES, EVENT_ICONS, BORDER_COLORS } from '../../lib/event-styles.js';

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function getEventSummary(event: TimelineEvent): string {
  const { data, type } = event;

  switch (type) {
    case 'tool_call_pending':
    case 'tool_call_approved':
    case 'tool_call_denied':
    case 'tool_call_delegated':
    case 'tool_call_completed':
    case 'tool_call_failed':
    case 'permission_request':
      return data.toolName ?? 'Unknown tool';
    case 'user_prompt':
      return `"${(data.prompt ?? '').slice(0, 80)}"`;
    case 'agent_response':
      return (data.prompt ?? '').slice(0, 80);
    case 'agent_stop':
      return 'agent stop';
    case 'session_start':
      return `Session started (${data.source ?? 'startup'})`;
    case 'session_end':
      return 'Session ended';
    case 'notification':
      return data.notificationType ?? 'Notification';
    case 'subagent_start':
      return `Subagent started: ${data.agentType ?? 'unknown'}`;
    case 'subagent_stop':
      return `Subagent stopped: ${data.agentType ?? 'unknown'}`;
    case 'stop_failure':
      return data.error ?? 'API error';
    case 'pre_compact':
      return 'Compaction starting';
    case 'post_compact':
      return 'Compaction complete';
    case 'elicitation':
      return (data.prompt ?? 'MCP structured input request').slice(0, 80);
    case 'elicitation_result':
      return (data.prompt ?? 'MCP structured input result').slice(0, 80);
    default:
      return type;
  }
}

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

function getCommandPreview(toolName: string | undefined, toolInput: Record<string, unknown> | undefined): string | null {
  if (!toolInput || !toolName) return null;
  if ('command' in toolInput) return String(toolInput.command);
  if ('file_path' in toolInput) return String(toolInput.file_path);
  if ('pattern' in toolInput) return String(toolInput.pattern);
  if ('query' in toolInput) return String(toolInput.query);
  if ('url' in toolInput) return String(toolInput.url);
  if ('prompt' in toolInput) return String(toolInput.prompt).slice(0, 120);
  return null;
}

export function EventCard({ event, index, isSelected, onClick, onSend, collapseHistory, showAgentBadge }: EventCardProps) {
  const [expandedLocal, setExpandedLocal] = useState(false);
  const { approvals } = usePendingApprovals();
  const showFullCommand = useSessionStore((s) => s.config?.showFullCommand ?? false);

  const isPending = event.type === 'tool_call_pending' || event.type === 'permission_request';
  const isAgentResponse = event.type === 'agent_response';
  const isFailed = event.type === 'tool_call_failed';
  const isUserPrompt = event.type === 'user_prompt';
  // When collapseHistory is on, expansion is driven by selection; otherwise use local toggle
  // agent_response, tool_call_failed, and user_prompt are always expanded so the content is visible without clicking
  const expanded = isPending || isAgentResponse || isFailed || isUserPrompt || (collapseHistory ? isSelected : expandedLocal);
  const borderColor = BORDER_COLORS[event.type] ?? 'border-l-[#30363d]';
  const icon = EVENT_ICONS[event.type] ?? '·';

  // Find matching pending approval
  const pendingApproval = isPending
    ? approvals.find(
        (a) => a.toolName === event.data.toolName && Math.abs(a.timestamp - event.timestamp) < 5000
      )
    : undefined;

  const bgClass = isPending
    ? 'bg-[#1c1a0f] hover:bg-[#1c1a0f]/80'
    : isSelected
      ? 'bg-[#1c2128]'
      : 'bg-[#161b22] hover:bg-[#1c2128]';

  const borderWidth = isPending ? 'border-l-2' : 'border-l';

  // agent_stop — Claude is done, waiting for user to type in terminal
  if (event.type === 'agent_stop') {
    return (
      <div
        className={`mx-3 mb-1.5 rounded-md border ${isSelected ? 'border-[#58a6ff]/40 bg-[#1c2128]' : 'border-[#30363d]/60 bg-[#161b22]'} cursor-pointer transition-colors`}
        onClick={onClick}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="text-[10px] text-[#484f58] font-mono tabular-nums shrink-0 w-6 text-right">{index + 1}</span>
          <span className="text-[#484f58]">—</span>
          <span className="text-[11px] text-[#484f58] font-mono">agent stop</span>
          <div className="flex-1" />
          <span className="text-[10px] text-[#58a6ff] bg-[#58a6ff]/10 border border-[#58a6ff]/20 px-1.5 py-0.5 rounded font-medium">
            awaiting your reply in terminal
          </span>
          <span className="text-[10px] text-[#484f58] font-mono tabular-nums shrink-0">{formatTime(event.timestamp)}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${bgClass} ${borderColor} ${borderWidth} mx-3 mb-1.5 rounded-md overflow-hidden transition-colors cursor-pointer ${
        isPending ? 'ring-1 ring-[#d29922]/30' : ''
      } ${isSelected ? 'ring-1 ring-[#58a6ff]/30' : ''}`}
      onClick={() => {
        onClick();
        if (!collapseHistory) setExpandedLocal((v) => !v);
      }}
    >
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2">
        {/* Sequence number */}
        <span className="text-[10px] text-[#484f58] font-mono tabular-nums shrink-0 w-6 text-right">
          {index + 1}
        </span>

        {/* Icon */}
        <span className="text-sm shrink-0">{icon}</span>

        {/* Type label */}
        <span className="text-[11px] text-[#8b949e] font-mono shrink-0">
          {event.type.replace(/_/g, ' ')}
        </span>

        {/* Tool name if present */}
        {event.data.toolName && (
          <>
            <span className="text-[11px] text-[#484f58]">·</span>
            <span className="text-[11px] font-semibold text-[#e6edf3] shrink-0">
              {event.data.toolName}
            </span>
            {showFullCommand && (() => {
              const preview = getCommandPreview(event.data.toolName, event.data.toolInput);
              return preview ? (
                <span className="text-[11px] text-[#484f58] font-mono truncate min-w-0">
                  {preview}
                </span>
              ) : null;
            })()}
          </>
        )}

        {/* Prompt text if present */}
        {event.data.prompt && !event.data.toolName && (
          <span className="text-xs text-[#58a6ff] truncate italic">
            {event.data.prompt.slice(0, 60)}
          </span>
        )}

        {/* Session/notification labels */}
        {event.data.source && (
          <span className="text-[11px] text-[#8b949e]">{event.data.source}</span>
        )}
        {event.data.notificationType && (
          <span className="text-[11px] text-[#8b949e]">{event.data.notificationType}</span>
        )}
        {event.data.agentType && (
          <span className="text-[11px] text-[#8b949e]">{event.data.agentType}</span>
        )}

        <div className="flex-1" />

        {/* Risk badge */}
        {event.riskLevel && event.riskLevel !== 'low' && (
          <RiskBadge level={event.riskLevel} compact />
        )}

        {/* Decision badge */}
        {event.data.decision && (
          <span className={`text-[10px] font-medium ${
            event.data.decision.decision === 'allow'
              ? 'text-[#3fb950]'
              : event.data.decision.decision === 'deny'
                ? 'text-[#f85149]'
                : 'text-[#8b949e]'
          }`}>
            {event.data.decision.decision.toUpperCase()}
          </span>
        )}

        {/* Pending badge */}
        {isPending && !event.data.decision && (
          <span className="text-[10px] font-semibold text-[#d29922] animate-pulse">
            PENDING
          </span>
        )}

        {/* Duration for completed tool calls */}
        {event.data.completedAt && (
          <span className="text-[10px] text-[#484f58] font-mono tabular-nums shrink-0">
            {formatDuration(event.data.completedAt - event.timestamp)}
          </span>
        )}

        {/* Timestamp */}
        <span className="text-[10px] text-[#484f58] font-mono tabular-nums shrink-0">
          {formatTime(event.timestamp)}
        </span>

        {/* Agent badge — only shown when multiple agent types are active */}
        {showAgentBadge && (() => {
          const badge = AGENT_BADGES[event.agentType] ?? { label: event.agentType.slice(0, 2).toUpperCase(), color: 'text-[#8b949e] bg-[#8b949e]/10 border-[#8b949e]/20' };
          return (
            <span className={`text-[9px] font-semibold px-1 py-0.5 rounded border ${badge.color} shrink-0`}>
              {badge.label}
            </span>
          );
        })()}
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-[#30363d]/50 pt-2">
          {/* Tool input — diff view for Edit/Write, code for everything else */}
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

            return (
              <div>
                <p className="text-[10px] text-[#484f58] mb-1 font-mono uppercase">Input</p>
                <CodeBlock
                  code={formatToolInput(input)}
                  language={tool === 'Bash' ? 'bash' : 'text'}
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
                  <span className="text-[10px] text-[#484f58] font-mono uppercase">Permission type</span>
                  <span className="text-[10px] font-medium text-[#d29922] bg-[#d29922]/10 border border-[#d29922]/20 px-1.5 py-0.5 rounded">
                    {event.data.permissionRequestType === 'tool_use' ? 'Tool Use' : 'Execution Mode'}
                  </span>
                </div>
              )}
              {event.data.permissionSuggestions && event.data.permissionSuggestions.length > 0 && (
                <div>
                  <p className="text-[10px] text-[#484f58] mb-1 font-mono uppercase">Allow suggestions</p>
                  <div className="space-y-1">
                    {(event.data.permissionSuggestions as Array<Record<string, unknown>>).map((s, i) => (
                      <div key={i} className="text-[11px] text-[#8b949e] bg-[#0d1117] rounded px-2 py-1 font-mono">
                        {s.description ? String(s.description) : s.command ? String(s.command) : JSON.stringify(s)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Prompt text — user_prompt and agent_response: markdown; others: plain */}
          {event.data.prompt && (
            (isAgentResponse || isUserPrompt) ? (
              <div className={`rounded-md border border-[#30363d] overflow-hidden`}>
                <div className="flex items-center justify-between px-3 py-1 bg-[#161b22] border-b border-[#30363d]">
                  <span className="text-[10px] text-[#484f58] font-mono uppercase">{isUserPrompt ? 'Prompt' : 'Response'}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(event.data.prompt as string).catch(() => {}); }}
                    className="text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors"
                  >
                    Copy
                  </button>
                </div>
                <div className={`p-3 text-xs text-[#e6edf3] border-l-2 ${isUserPrompt ? 'border-[#58a6ff]' : 'border-[#3fb950]/50'} prose prose-invert prose-xs max-w-none
                  [&_p]:my-1 [&_p]:leading-relaxed
                  [&_strong]:text-[#e6edf3] [&_strong]:font-semibold
                  [&_em]:text-[#8b949e]
                  [&_code]:text-[#79c0ff] [&_code]:bg-[#0d1117] [&_code]:px-1 [&_code]:rounded [&_code]:text-[11px]
                  [&_pre]:bg-[#0d1117] [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto
                  [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1
                  [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:my-1
                  [&_li]:my-0.5
                  [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold`}>
                  <ReactMarkdown>{event.data.prompt as string}</ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-[#30363d] overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1 bg-[#161b22] border-b border-[#30363d]">
                  <span className="text-[10px] text-[#484f58] font-mono uppercase">Prompt</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(event.data.prompt as string).catch(() => {}); }}
                    className="text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors"
                  >
                    Copy
                  </button>
                </div>
                <pre className="p-3 text-xs text-[#e6edf3] leading-relaxed whitespace-pre-wrap break-words font-sans border-l-2 border-[#58a6ff]">
                  {event.data.prompt as string}
                </pre>
              </div>
            )
          )}

          {/* Error */}
          {event.data.error && (
            <div>
              <p className="text-[10px] text-[#f85149] mb-1 font-mono uppercase">Error</p>
              <CodeBlock code={event.data.error} maxLines={15} className="border-[#f85149]/30" />
            </div>
          )}

          {/* Tool output (for completed events) */}
          {event.data.toolOutput !== undefined && expanded && (
            <div>
              <p className="text-[10px] text-[#484f58] mb-1 font-mono uppercase">Output</p>
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
            <p className="text-xs text-[#f85149]">
              Reason: {event.data.decision.reason}
            </p>
          )}

          {/* Analysis card */}
          {event.analysis && (
            <div className="bg-[#0d1117] border border-[#30363d] rounded-md p-3">
              <p className="text-[10px] text-[#484f58] font-mono uppercase mb-2">Analysis</p>
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
      )}
    </div>
  );
}
