import React, { useState } from 'react';
import type { TimelineEvent } from '../../lib/types.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import { RiskBadge } from '../shared/RiskBadge.js';
import { ApprovalBar } from '../controls/ApprovalBar.js';
import { AnalysisCard } from '../analysis/AnalysisCard.js';
import { CodeBlock } from '../shared/CodeBlock.js';
import { usePendingApprovals } from '../../hooks/usePendingApprovals.js';

interface EventCardProps {
  event: TimelineEvent;
  index: number;
  isSelected: boolean;
  onClick: () => void;
  onSend: (msg: ClientMessage) => void;
}

const EVENT_ICONS: Record<string, string> = {
  tool_call_pending: '⚡',
  tool_call_approved: '✅',
  tool_call_denied: '❌',
  tool_call_delegated: '⏭',
  tool_call_completed: '✓',
  tool_call_failed: '✗',
  permission_request: '🔐',
  user_prompt: '💬',
  agent_stop: '—',
  session_start: '🟢',
  session_end: '⬜',
  notification: '🔔',
  subagent_start: '🔀',
  subagent_stop: '🔀',
  analysis_result: '🔍',
};

const BORDER_COLORS: Record<string, string> = {
  tool_call_pending: 'border-l-[#d29922]',
  tool_call_approved: 'border-l-[#3fb950]',
  tool_call_denied: 'border-l-[#f85149]',
  tool_call_delegated: 'border-l-[#8b949e]',
  tool_call_completed: 'border-l-[#3fb950]/50',
  tool_call_failed: 'border-l-[#f85149]',
  permission_request: 'border-l-[#d29922]',
  user_prompt: 'border-l-[#58a6ff]',
  agent_stop: 'border-l-[#30363d]',
  session_start: 'border-l-[#3fb950]',
  session_end: 'border-l-[#30363d]',
  notification: 'border-l-[#58a6ff]',
  subagent_start: 'border-l-[#58a6ff]',
  subagent_stop: 'border-l-[#8b949e]',
  analysis_result: 'border-l-[#8b949e]',
};

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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
    case 'agent_stop':
      return 'Claude finished responding';
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

export function EventCard({ event, index, isSelected, onClick, onSend }: EventCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { approvals } = usePendingApprovals();

  const isPending = event.type === 'tool_call_pending' || event.type === 'permission_request';
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

  // Thin divider for agent_stop
  if (event.type === 'agent_stop') {
    return (
      <div className="flex items-center gap-2 px-4 py-1 opacity-40">
        <div className="flex-1 h-px bg-[#30363d]" />
        <span className="text-[10px] text-[#484f58] font-mono">{formatTime(event.timestamp)}</span>
        <div className="flex-1 h-px bg-[#30363d]" />
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
        setExpanded(!expanded);
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
            <span className="text-[11px] font-semibold text-[#e6edf3] truncate">
              {event.data.toolName}
            </span>
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

        {/* Timestamp */}
        <span className="text-[10px] text-[#484f58] font-mono tabular-nums shrink-0">
          {formatTime(event.timestamp)}
        </span>
      </div>

      {/* Expanded content */}
      {(expanded || isPending) && (
        <div className="px-3 pb-3 space-y-2 border-t border-[#30363d]/50 pt-2">
          {/* Tool input */}
          {event.data.toolInput && (
            <div>
              <p className="text-[10px] text-[#484f58] mb-1 font-mono uppercase">Input</p>
              <CodeBlock
                code={formatToolInput(event.data.toolInput)}
                language={event.data.toolName === 'Bash' ? 'bash' : 'text'}
                maxLines={10}
              />
            </div>
          )}

          {/* Prompt text */}
          {event.data.prompt && (
            <blockquote className="text-xs text-[#e6edf3] border-l-2 border-[#58a6ff] pl-3 italic">
              {event.data.prompt}
            </blockquote>
          )}

          {/* Error */}
          {event.data.error && (
            <div className="text-xs text-[#f85149] bg-[#f85149]/10 border border-[#f85149]/20 rounded px-3 py-2 font-mono">
              {event.data.error}
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

          {/* Approval bar for pending events */}
          {isPending && pendingApproval && !event.data.decision && (
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
