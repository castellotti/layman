import React, { useMemo } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { EVENT_KIND_COLOR, kindLabel, eventDetail } from '../../lib/event-styles.js';
import { formatTime } from '../../lib/format.js';
import { EventDetailBody } from '../events/EventCard.js';
import type { TimelineEvent } from '../../lib/types.js';
import { safeLabel } from '../../lib/station.js';
import { rowStation, STATION_STYLE } from '../../lib/station-style.js';
import { useStationSetup } from '../../hooks/useStationSetup.js';
import { StationGlyph } from '../activity/StationGlyph.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';

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
  // The card is tinted by the real highlight (the prompt–response pair kept in
  // Prompts), the one its Highlight button sets and the minimap marks.
  const highlighted = useSessionStore((s) => s.highlightedEventIds.has(event.id));

  const setup = useStationSetup();
  // The tooltip names the call without its content (the row itself already shows the content).
  const { station, stationTitle } = useMemo(() => {
    const st = rowStation(event, setup);
    if (!st) return { station: undefined, stationTitle: undefined };
    const name = STATION_STYLE[st].label;
    const { toolName, toolInput } = event.data;
    return { station: st, stationTitle: toolName ? `${name} · ${safeLabel(toolName, toolInput as Record<string, unknown> | undefined, setup)}` : name };
  }, [event, setup]);

  const color = EVENT_KIND_COLOR[event.type] ?? 'var(--text-muted)';
  const expanded = hasDetail && isExpanded;

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
        <span data-station={station} style={{ width: 12, flexShrink: 0 }}>
          {station && <StationGlyph station={station} title={stationTitle} />}
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
          <EventDetailBody event={event} onSend={onSend} />
        </div>
      )}
    </div>
  );
});
