import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useEventStore } from '../../hooks/useEventStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { LogRow } from '../logs/LogRow.js';
import { TurnHeader } from '../logs/TurnHeader.js';
import { NavigationBar } from '../controls/NavigationBar.js';
import { SessionMetricsBar } from '../controls/SessionMetricsBar.js';
import { PromptInput } from '../controls/PromptInput.js';
import { Minimap } from '../logs/Minimap.js';
import { LiveStreamRow } from '../logs/LiveStreamRow.js';
import { withThinkingRows, baseEventId, isThinkingRow } from '../../lib/event-styles.js';
import { JumpToLatest } from '../primitives/index.js';
import { saveAndBookmarkSession } from '../../lib/bookmarks-api.js';
import { pairFor, hasLogDetail } from '../../lib/event-pairing.js';
import { extractTurns } from '../../lib/turns.js';
import { sessionDisplayName } from '../../lib/session-state.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';

interface EventStreamProps {
  onSend: (msg: ClientMessage) => void;
  archived?: boolean;
  archivedDate?: string;
  /**
   * Group the list under one collapsible header per turn. Opt-in so the live
   * Logs view keeps its current density; the archived transcript turns it on.
   */
  turnRuler?: boolean;
}

export function EventStream({ onSend, archived = false, archivedDate, turnRuler = false }: EventStreamProps) {
  const [promptsOnly, setPromptsOnly] = useState(false);
  const [requestsOnly, setRequestsOnly] = useState(false);
  const [responsesOnly, setResponsesOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [followLatest, setFollowLatest] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const {
    sessions, activeSessionId, config, fetchAccessLog, scrollToEventId, clearScrollToEvent, bookmarks,
    logHighlightedEventIds, expandedLogEventIds, setExpandedLogEventIds, toggleExpandAllLogs,
    bookmarksScrollToEventId, setBookmarksScrollToEventId,
  } = useSessionStore();
  const historicalEventsFromStore = useSessionStore((s) => s.historicalEvents);

  const autoScroll = config?.autoScroll ?? true;

  // For archived sessions, source events from historicalEvents in the store
  const sourceOverride = archived ? historicalEventsFromStore : undefined;

  const { events, sessionEvents, totalCount } = useEventStore({
    promptsOnly,
    requestsOnly,
    responsesOnly,
    searchQuery,
  }, sourceOverride);

  // ─── Display rows ─────────────────────────────────────────────────────────
  // Reasoning is lifted out of each response into a row of its own. Everything
  // that renders rows *or* indexes into them works off these lists, so the
  // keyboard cursor, the minimap and the rendered order cannot drift apart.
  const displayEvents = useMemo(() => withThinkingRows(events), [events]);
  const displaySessionEvents = useMemo(() => withThinkingRows(sessionEvents), [sessionEvents]);

  // Index map: event ID → position in sessionEvents (stable "#n" row numbers)
  const eventIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    sessionEvents.forEach((e, i) => map.set(e.id, i));
    return map;
  }, [sessionEvents]);

  /** Row number for a display row — a thinking row borrows its response's. */
  const rowNumber = useCallback(
    (rowId: string) => eventIndexMap.get(baseEventId(rowId)) ?? 0,
    [eventIndexMap]
  );

  // Rows with an expandable detail card — computed against the full (unfiltered)
  // per-session list so pairing/expand-all always operates on real exchanges, and
  // against the *display* list so it covers derived thinking rows. Built from
  // `sessionEvents` it silently omitted them: "Expand all" left every reasoning
  // row collapsed while `allExpanded` flipped the label to "Collapse all".
  const detailEventIds = useMemo(
    () => displaySessionEvents.filter((e) => isThinkingRow(e) || hasLogDetail(e)).map((e) => e.id),
    [displaySessionEvents]
  );
  const detailEventIdSet = useMemo(() => new Set(detailEventIds), [detailEventIds]);
  const effectiveExpanded = useMemo(
    () => (expandedLogEventIds === 'all' ? new Set(detailEventIds) : expandedLogEventIds),
    [expandedLogEventIds, detailEventIds]
  );
  const allExpanded = detailEventIds.length > 0 && detailEventIds.every((id) => effectiveExpanded.has(id));
  const expandToggleLabel = allExpanded ? '⊟ Collapse all' : '⊞ Expand all';

  // ─── Turn ruler ───────────────────────────────────────────────────────────
  // Turns come from the unfiltered per-session list so numbering and ownership
  // match the server's; a filtered-out prompt simply shows no header.
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(new Set());
  const selectedTurnPromptEventId = useSessionStore((s) => s.selectedTurnPromptEventId);
  const selectTurn = useSessionStore((s) => s.selectTurn);

  const turns = useMemo(
    () => (turnRuler ? extractTurns(sessionEvents) : []),
    [turnRuler, sessionEvents]
  );
  const turnByPromptId = useMemo(() => new Map(turns.map((t) => [t.promptEventId, t])), [turns]);
  /** Events hidden because the turn owning them is collapsed. */
  const hiddenByCollapse = useMemo(() => {
    if (collapsedTurns.size === 0) return new Set<string>();
    const hidden = new Set<string>();
    for (const turn of turns) {
      if (!collapsedTurns.has(turn.promptEventId)) continue;
      for (const id of turn.eventIds) hidden.add(id);
    }
    return hidden;
  }, [turns, collapsedTurns]);

  const toggleTurnCollapsed = useCallback((promptEventId: string) => {
    setCollapsedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(promptEventId)) next.delete(promptEventId);
      else next.add(promptEventId);
      return next;
    });
  }, []);

  // Row line click — select-to-focus: expand this row + its pair, collapse the rest.
  // Also moves the keyboard-navigation cursor here so arrow-key nav continues from the click.
  const handleSelectRow = useCallback((eventId: string) => {
    // A thinking row has no paired event for select-to-focus to open, so it
    // toggles only itself; pairing is resolved against the real event list.
    setExpandedLogEventIds(
      eventId === baseEventId(eventId)
        ? new Set(pairFor(eventId, sessionEvents))
        : new Set([eventId])
    );
    const idx = displayEvents.findIndex((e) => e.id === eventId);
    if (idx >= 0) {
      setSelectedIndex(idx);
      if (idx < displayEvents.length - 1) setFollowLatest(false);
    }
  }, [sessionEvents, displayEvents, setExpandedLogEventIds]);

  // Caret click — manual toggle of just this row
  const handleCaretToggle = useCallback((eventId: string) => {
    const next = new Set(effectiveExpanded);
    if (next.has(eventId)) next.delete(eventId);
    else next.add(eventId);
    setExpandedLogEventIds(next);
  }, [effectiveExpanded, setExpandedLogEventIds]);

  const handleExpandToggle = useCallback(() => {
    toggleExpandAllLogs(detailEventIds);
  }, [toggleExpandAllLogs, detailEventIds]);

  // Auto-scroll to bottom when new events actually arrive and following (live only).
  const prevSessionEventCountRef = useRef(sessionEvents.length);
  useEffect(() => {
    const grew = sessionEvents.length > prevSessionEventCountRef.current;
    prevSessionEventCountRef.current = sessionEvents.length;
    if (!archived && autoScroll && followLatest && grew && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [sessionEvents.length, autoScroll, followLatest, archived]);

  useEffect(() => {
    if (!archived && autoScroll && followLatest && displayEvents.length > 0) {
      setSelectedIndex(displayEvents.length - 1);
    }
  }, [displayEvents.length, autoScroll, followLatest, archived]);

  // Scroll to a specific event — select its pair (so context is visible) and scroll
  // the row into view. Live Logs is driven by scrollToEventId (Dashboard drilldown);
  // the archived transcript by bookmarksScrollToEventId, which is what a /t/ or /e/
  // deep link and the Prompts view's "Open session" both set.
  const pendingScrollEventId = archived ? bookmarksScrollToEventId : scrollToEventId;
  const clearPendingScroll = useCallback(() => {
    if (archived) setBookmarksScrollToEventId(null);
    else clearScrollToEvent();
  }, [archived, setBookmarksScrollToEventId, clearScrollToEvent]);

  useEffect(() => {
    if (!pendingScrollEventId) return;

    setExpandedLogEventIds(new Set(pairFor(pendingScrollEventId, sessionEvents)));

    const idx = displayEvents.findIndex((e) => e.id === pendingScrollEventId);
    if (idx >= 0) setSelectedIndex(idx);
    setFollowLatest(false);
    clearPendingScroll();

    requestAnimationFrame(() => {
      const cards = scrollRef.current?.querySelectorAll('[data-event-card]');
      if (cards) {
        const target = Array.from(cards).find((c) => c.getAttribute('data-event-id') === pendingScrollEventId);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }, [pendingScrollEventId, events, sessionEvents, clearPendingScroll, setExpandedLogEventIds]);

  // When tab becomes visible again, re-sync scroll position if following (live only)
  useEffect(() => {
    if (archived) return;
    const handleVisibilityChange = () => {
      if (!document.hidden && autoScroll && scrollRef.current) {
        setFollowLatest(true);
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [autoScroll, archived]);

  const handleScroll = useCallback(() => {
    if (!autoScroll || archived) return;
    if (document.hidden) return;
    const el = scrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setFollowLatest(isAtBottom);
  }, [autoScroll, archived]);

  const jumpToLatest = useCallback(() => {
    const idx = displayEvents.length - 1;
    setSelectedIndex(idx);
    setFollowLatest(true);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayEvents]);

  const handlePrint = useCallback(() => {
    document.body.classList.add('layman-print-live');
    const cleanup = () => {
      document.body.classList.remove('layman-print-live');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
  }, []);

  // Search match navigation — resets to the first match on every new query
  useEffect(() => {
    setMatchIndex(0);
  }, [searchQuery]);

  const hasSearchQuery = searchQuery.trim().length > 0;
  const matchCount = hasSearchQuery ? displayEvents.length : 0;

  const scrollToMatch = useCallback((idx: number) => {
    const container = scrollRef.current;
    if (!container) return;
    const cards = container.querySelectorAll('[data-event-card]');
    const card = cards[idx] as HTMLElement | undefined;
    if (!card) return;
    const containerRect = container.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const delta = (cardRect.top - containerRect.top) - (container.clientHeight / 2 - cardRect.height / 2);
    container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' });
  }, []);

  const goToPrevMatch = useCallback(() => {
    if (matchCount === 0) return;
    const idx = (matchIndex - 1 + matchCount) % matchCount;
    setMatchIndex(idx);
    scrollToMatch(idx);
  }, [matchIndex, matchCount, scrollToMatch]);

  const goToNextMatch = useCallback(() => {
    if (matchCount === 0) return;
    const idx = (matchIndex + 1) % matchCount;
    setMatchIndex(idx);
    scrollToMatch(idx);
  }, [matchIndex, matchCount, scrollToMatch]);

  const goToIndex = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(idx, displayEvents.length - 1));
    setSelectedIndex(clamped);
    const cards = scrollRef.current?.querySelectorAll('[data-event-card]');
    if (cards && cards[clamped]) {
      cards[clamped].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [displayEvents]);

  // Keyboard navigation + expand/collapse-all (E)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          goToIndex(selectedIndex - 1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          goToIndex(selectedIndex + 1);
          break;
        case 'Home':
          e.preventDefault();
          goToIndex(0);
          break;
        case 'End':
          e.preventDefault();
          goToIndex(displayEvents.length - 1);
          setFollowLatest(true);
          break;
        case 'p':
        case 'P':
          setPromptsOnly(v => !v);
          break;
        case 'q':
        case 'Q':
          setRequestsOnly(v => !v);
          break;
        case 'r':
        case 'R':
          setResponsesOnly(v => !v);
          break;
        case 'e':
        case 'E':
          handleExpandToggle();
          break;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedIndex, displayEvents.length, goToIndex, handleExpandToggle]);

  const bookmarkedSessionIds = useMemo(
    () => new Set(bookmarks.map((b) => b.sessionId)),
    [bookmarks]
  );

  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );

  const defaultBookmarkName = useMemo(() => {
    if (!activeSession) return activeSessionId?.slice(0, 8) ?? '';
    const { cwd, sessionId, sessionName } = activeSession;
    return sessionDisplayName(sessionName, cwd, sessionId);
  }, [activeSession, activeSessionId]);

  const handleBookmark = useCallback((name: string) => {
    if (!activeSessionId) return;
    void saveAndBookmarkSession(activeSessionId, name.trim() || activeSessionId.slice(0, 8));
  }, [activeSessionId]);

  // Harnesses whose integration can inject a prompt into a running session.
  // Mirrors the allow-list on POST /api/sessions/:id/prompt — offering the input
  // for a harness the server will reject just produces a silent dead end.
  const PROMPTABLE_AGENTS = ['opencode', 'pi'];
  const promptableSession =
    (activeSessionId !== null
      ? sessions.find((s) => s.sessionId === activeSessionId && PROMPTABLE_AGENTS.includes(s.agentType))
      : null) ?? sessions.find((s) => PROMPTABLE_AGENTS.includes(s.agentType)) ?? null;

  const hasEvents = sessionEvents.length > 0;
  const bufferedCount = totalCount - events.length;

  return (
    <div className="flex flex-col h-full w-full min-w-0">
      <NavigationBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        promptsOnly={promptsOnly}
        requestsOnly={requestsOnly}
        responsesOnly={responsesOnly}
        onTogglePromptsOnly={() => setPromptsOnly(v => !v)}
        onToggleRequestsOnly={() => setRequestsOnly(v => !v)}
        onToggleResponsesOnly={() => setResponsesOnly(v => !v)}
        onClearFilters={() => {
          setPromptsOnly(false);
          setRequestsOnly(false);
          setResponsesOnly(false);
        }}
        followLatest={followLatest}
        archived={archived}
        archivedDate={archivedDate}
        onAccessLog={!archived && activeSessionId ? () => void fetchAccessLog(activeSessionId) : undefined}
        onPrint={handlePrint}
        onBookmark={!archived && activeSessionId ? handleBookmark : undefined}
        isBookmarked={!archived && activeSessionId ? bookmarkedSessionIds.has(activeSessionId) : true}
        defaultBookmarkName={defaultBookmarkName}
        expandToggleLabel={expandToggleLabel}
        onExpandToggle={hasEvents ? handleExpandToggle : undefined}
      />

      {!archived && <SessionMetricsBar />}

      {/* Search match navigation bar */}
      {hasSearchQuery && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '6px 14px', background: 'var(--bg-selected)',
          borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <span style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>
            {matchCount === 0 ? 'No matches' : `${matchCount} match${matchCount === 1 ? '' : 'es'} · ${matchIndex + 1}/${matchCount}`}
          </span>
          <button
            onClick={goToPrevMatch}
            disabled={matchCount === 0}
            style={{
              padding: '1px 8px', fontSize: 11, fontFamily: 'inherit',
              background: 'transparent', color: 'var(--text-muted)',
              border: '1px solid var(--border-strong)', borderRadius: 4,
              cursor: matchCount === 0 ? 'default' : 'pointer',
            }}
          >
            ‹
          </button>
          <button
            onClick={goToNextMatch}
            disabled={matchCount === 0}
            style={{
              padding: '1px 8px', fontSize: 11, fontFamily: 'inherit',
              background: 'transparent', color: 'var(--text-muted)',
              border: '1px solid var(--border-strong)', borderRadius: 4,
              cursor: matchCount === 0 ? 'default' : 'pointer',
            }}
          >
            ›
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
            clearing the search keeps this position
          </span>
        </div>
      )}

      {/* Content area: minimap + scroll area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
        {/* Minimap */}
        {hasEvents && (
          <Minimap events={displaySessionEvents} scrollRef={scrollRef} highlightedEventIds={logHighlightedEventIds} />
        )}

        {/* Scroll area */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          data-print-stream
          style={{ flex: 1, overflowY: 'auto', paddingTop: 4, paddingBottom: 4 }}
        >
          {!hasEvents ? (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', height: '100%', gap: 12, textAlign: 'center',
              padding: '0 32px',
            }}>
              <div style={{ fontSize: 36 }}>👁</div>
              <p style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 500, color: 'var(--text)', margin: 0 }}>
                Waiting for events…
              </p>
              <p style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                Hooks are installed. Start a Claude Code, Codex, Cline, OpenCode, or Mistral Vibe session to see events here.
              </p>
              <div style={{
                marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)',
                background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6,
                padding: '10px 16px', textAlign: 'left',
              }}>
                <p style={{ color: 'var(--text-muted)', margin: '0 0 4px 0' }}># In your AI agent:</p>
                <p style={{ margin: 0 }}>type /layman to begin</p>
              </div>
            </div>
          ) : (
            displayEvents.map((event, i) => {
              const turn = turnByPromptId.get(event.id);
              // Turn ownership and collapse are keyed on real event ids, so a
              // derived thinking row resolves through its response's id and
              // hides and shows with the turn it belongs to.
              const hidden = hiddenByCollapse.has(baseEventId(event.id));
              if (hidden && !turn) return null;

              return (
                <React.Fragment key={event.id}>
                  {turn && (
                    <TurnHeader
                      turn={turn}
                      collapsed={collapsedTurns.has(turn.promptEventId)}
                      addressed={selectedTurnPromptEventId === turn.promptEventId}
                      onToggle={() => toggleTurnCollapsed(turn.promptEventId)}
                      onSelect={() => selectTurn(turn.sessionId, turn.promptEventId)}
                    />
                  )}
                  {!hidden && (
                    <LogRow
                      event={event}
                      index={rowNumber(event.id)}
                      // One list decides what is expandable and what "Expand
                      // all" expands; a thinking row is always in it, since its
                      // whole content is the detail.
                      hasDetail={detailEventIdSet.has(event.id)}
                      isExpanded={effectiveExpanded.has(event.id)}
                      isSelected={i === selectedIndex}
                      onSelect={handleSelectRow}
                      onCaretToggle={handleCaretToggle}
                      onSend={onSend}
                    />
                  )}
                </React.Fragment>
              );
            })
          )}

          {/* Partial output, pinned to the tail. Renders nothing when the
              harness does not stream or the agent is idle. An archived
              transcript is by definition not live. */}
          {!archived && <LiveStreamRow sessionId={activeSessionId} />}
        </div>

        {/* Jump to latest pill — floats above the stream (live only) */}
        {!archived && autoScroll && !followLatest && totalCount > 0 && (
          <div data-print-hide style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10,
          }}>
            <JumpToLatest
              count={Math.max(0, bufferedCount)}
              onClick={jumpToLatest}
            />
          </div>
        )}
      </div>

      {!archived && promptableSession && (
        <div data-print-hide>
          <PromptInput sessionId={promptableSession.sessionId} />
        </div>
      )}
    </div>
  );
}
