import React, { useMemo } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { EVENT_KIND_COLOR, kindLabel, eventDetail, eventHeading } from '../../lib/event-styles.js';
import { tokenColor } from '../../lib/tokens.js';
import { formatTime } from '../../lib/format.js';
import { EventDetailBody, EventActions } from '../events/EventCard.js';
import type { TimelineEvent } from '../../lib/types.js';
import { safeLabel } from '../../lib/station.js';
import { rowStation, STATION_STYLE } from '../../lib/station-style.js';
import { useStationSetup } from '../../hooks/useStationSetup.js';
import { StationGlyph } from '../activity/StationGlyph.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import { sp, rad } from '../../lib/density.js';

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
  // The body is tinted, and its left rule coloured, by the real highlight (the
  // prompt–response pair kept in Prompts), the one its Highlight button sets and the minimap marks.
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

  const color = tokenColor(EVENT_KIND_COLOR[event.type] ?? 'text-muted');
  const expanded = hasDetail && isExpanded;

  return (
    <div data-event-card data-event-id={event.id}>
      <div
        onClick={() => hasDetail && onSelect(event.id)}
        style={{
          display: 'flex', alignItems: 'center', flexWrap: expanded ? 'wrap' : 'nowrap', gap: sp(6), padding: sp('3px 8px'), margin: sp('0 8px'),
          borderRadius: rad(4), cursor: hasDetail ? 'pointer' : 'default',
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
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 10, flex: 1, minWidth: expanded ? 120 : 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: expanded ? 'var(--text)' : 'var(--text-body)', fontWeight: expanded ? 500 : undefined,
        }}>
          {expanded ? eventHeading(event) : eventDetail(event)}
        </span>
        {expanded && <EventActions event={event} />}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-faint)', flexShrink: 0 }}>
          {formatTime(event.timestamp)}
        </span>
      </div>

      {expanded && (
        <div
          style={{
            margin: sp('1px 8px 6px 52px'),
            paddingLeft: sp(10),
            borderLeft: `2px solid ${highlighted ? 'var(--warn)' : color}`,
            background: highlighted ? tokenColor('warn', '6%') : 'transparent',
            minWidth: 0,
            animation: 'fadeIn 0.15s ease',
          }}
        >
          <EventDetailBody event={event} onSend={onSend} />
        </div>
      )}
    </div>
  );
});
