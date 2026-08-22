import React, { useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { EVENT_KIND_COLOR, kindLabel, eventDetail } from '../../lib/event-styles.js';
import { formatTime } from '../../lib/format.js';
import { getEffectiveAgentContent } from '../../lib/reasoning.js';
import { EventDetailBody } from '../events/EventCard.js';
import { RiskBadge } from '../shared/RiskBadge.js';
import { MagnifierIcon, CopyLinkButton } from '../primitives/index.js';
import { SpeakButton } from '../tts/SpeakButton.js';
import type { TimelineEvent } from '../../lib/types.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';

function detailLabel(event: TimelineEvent): string {
  if (event.type === 'user_prompt') return 'PROMPT';
  if (event.type === 'agent_response') return 'RESPONSE';
  if (event.type === 'agent_thinking') return 'THINKING';
  if (event.data.toolName) return event.data.toolName.toUpperCase();
  return kindLabel(event.type).toUpperCase();
}

/** Copies the raw source text for an event's detail — never the rendered DOM. */
function sourceTextFor(event: TimelineEvent): string {
  if (event.type === 'agent_response') return getEffectiveAgentContent(event).response;
  // The derived reasoning row carries its text in `prompt` (see thinkingRowFor).
  if (event.type === 'agent_thinking') return event.data.prompt ?? '';
  if (event.data.prompt) return event.data.prompt;
  if (event.data.toolInput) {
    const input = event.data.toolInput;
    if ('command' in input) return String(input.command);
    return JSON.stringify(input, null, 2);
  }
  if (event.data.error) return event.data.error;
  return eventDetail(event);
}

interface LogRowProps {
  event: TimelineEvent;
  index: number;
  hasDetail: boolean;
  isExpanded: boolean;
  isSelected?: boolean;
  onSelect: (eventId: string) => void;
  onCaretToggle: (eventId: string) => void;
  onSend: (msg: ClientMessage) => void;
}

export const LogRow = React.memo(function LogRow({ event, index, hasDetail, isExpanded, isSelected, onSelect, onCaretToggle, onSend }: LogRowProps) {
  const [copied, setCopied] = useState(false);
  const highlighted = useSessionStore((s) => s.logHighlightedEventIds.has(event.id));
  const toggleLogHighlight = useSessionStore((s) => s.toggleLogHighlight);
  const setSelectedEvent = useSessionStore((s) => s.setSelectedEvent);

  const color = EVENT_KIND_COLOR[event.type] ?? 'var(--text-muted)';
  const expanded = hasDetail && isExpanded;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(sourceTextFor(event)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div data-event-card data-event-id={event.id}>
      <div
        onClick={() => hasDetail && onSelect(event.id)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', margin: '0 8px',
          borderRadius: 4, cursor: hasDetail ? 'pointer' : 'default',
          background: expanded ? 'var(--bg-selected)' : 'transparent',
          boxShadow: isSelected ? 'inset 0 0 0 1px var(--accent)' : 'none',
        }}
        onMouseEnter={(e) => { if (!expanded) (e.currentTarget as HTMLElement).style.background = 'var(--bg-card)'; }}
        onMouseLeave={(e) => { if (!expanded) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-faint)', width: 34, textAlign: 'right', flexShrink: 0 }}>
          #{index + 1}
        </span>
        <span
          onClick={(e) => { e.stopPropagation(); if (hasDetail) onCaretToggle(event.id); }}
          title={hasDetail ? 'Expand/collapse just this row' : undefined}
          style={{ width: 12, flexShrink: 0, fontSize: 8, color: 'var(--text-faint)', textAlign: 'center', cursor: hasDetail ? 'pointer' : 'default' }}
        >
          {hasDetail ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 500, color, flexShrink: 0, minWidth: 68 }}>
          {kindLabel(event.type)}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-body)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {eventDetail(event)}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-faint)', flexShrink: 0 }}>
          {formatTime(event.timestamp)}
        </span>
      </div>

      {expanded && (
        <div
          style={{
            margin: '2px 8px 8px 52px',
            border: `1px solid ${highlighted ? 'rgba(229,168,59,0.35)' : 'var(--border)'}`,
            borderLeft: `2px solid ${highlighted ? 'var(--warn)' : color}`,
            borderRadius: 6,
            background: highlighted ? 'rgba(229,168,59,0.06)' : 'var(--bg-raised)',
            overflow: 'hidden',
            animation: 'fadeIn 0.15s ease',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--text-faint)' }}>
              {detailLabel(event)}
            </span>
            <div style={{ flex: 1 }} />
            <button
              onClick={(e) => { e.stopPropagation(); toggleLogHighlight(event.id); }}
              title="Highlight this row (shown on the minimap)"
              style={{ fontSize: 10, background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: highlighted ? 'var(--warn)' : 'var(--text-muted)' }}
              onMouseEnter={(e) => { if (!highlighted) e.currentTarget.style.color = 'var(--text)'; }}
              onMouseLeave={(e) => { if (!highlighted) e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              Highlight
            </button>
            <button
              onClick={handleCopy}
              style={{ fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            {event.type === 'agent_response' && (
              <SpeakButton
                id={event.id}
                text={getEffectiveAgentContent(event).response}
                title="Speak this response aloud"
              />
            )}
            <CopyLinkButton
              route={{ kind: 'event', sessionId: event.sessionId, eventId: event.id }}
              title="Copy link to this event"
              label="Link"
            />
            {event.riskLevel && event.riskLevel !== 'low' && <RiskBadge level={event.riskLevel} compact />}
            <button
              onClick={(e) => { e.stopPropagation(); setSelectedEvent(event.id); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--accent)',
                background: 'rgba(90,156,248,0.1)', border: '1px solid rgba(90,156,248,0.25)',
                borderRadius: 4, padding: '1px 8px', cursor: 'pointer',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(90,156,248,0.18)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(90,156,248,0.1)')}
            >
              <MagnifierIcon strokeWidth={1.6} />
              Investigate
            </button>
          </div>
          <EventDetailBody event={event} onSend={onSend} />
        </div>
      )}
    </div>
  );
});
