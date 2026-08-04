import React, { useState, useCallback, useEffect, useRef, useMemo, Suspense, lazy } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { EventStream } from '../layout/EventStream.js';
import { InvestigationPanel } from '../layout/InvestigationPanel.js';
import { SearchInput, SegmentedControl, SECTION_LABEL_STYLE, CollapsibleFolderHeader, NewFolderRow, ConfirmDialog } from '../primitives/index.js';
import { useDragReorder } from '../../hooks/useDragReorder.js';
import { useOptimisticOrder } from '../../hooks/useOptimisticOrder.js';
import { useFolderDrag, reorderIds, type FolderDragSource, type FolderDropTarget } from '../../hooks/useFolderDrag.js';
import { useFolderCrud } from '../../hooks/useFolderCrud.js';
import { sessionDisplayName } from '../../lib/session-state.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import type { RecordedSession, SessionTimeMetrics } from '../../lib/types.js';

const FlowchartView = lazy(() =>
  import('../flowchart/FlowchartView.js').then((m) => ({ default: m.FlowchartView }))
);

interface SessionsViewProps {
  onSend: (msg: ClientMessage) => void;
}

function formatDateShort(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function SessionsView({ onSend }: SessionsViewProps) {
  const {
    bookmarkFolders,
    bookmarks,
    viewingSessionId,
    setViewingSession,
    setHistoricalEvents,
    historicalEvents,
    setSessionTimeMetrics,
    investigationOpen,
    setInvestigationOpen,
    setSelectedEvent,
    sessions,
  } = useSessionStore();

  const [recordedSessions, setRecordedSessions] = useState<RecordedSession[]>([]);
  const [filter, setFilter] = useState<'all' | 'bookmarked'>('all');
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState<string | null>(null);
  const [deleteConfirmFolderId, setDeleteConfirmFolderId] = useState<string | null>(null);
  const [leftWidthPct, setLeftWidthPct] = useState(60);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const [showFlowchart, setShowFlowchart] = useState(false);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const dividerDragging = useRef(false);

  const liveSessionIds = useMemo(() => new Set(sessions.map((s) => s.sessionId)), [sessions]);
  const bookmarkedSessionIds = useMemo(() => new Set(bookmarks.map((b) => b.sessionId)), [bookmarks]);
  const bookmarkIdBySessionId = useMemo(() => new Map(bookmarks.map((b) => [b.sessionId, b.id])), [bookmarks]);
  const bookmarkIdForSession = useCallback(
    (sessionId: string) => bookmarkIdBySessionId.get(sessionId) ?? null,
    [bookmarkIdBySessionId]
  );
  const sortedFolders = useMemo(
    () => [...bookmarkFolders].sort((a, b) => a.sortOrder - b.sortOrder),
    [bookmarkFolders]
  );

  // Divider drag
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dividerDragging.current || !rightPanelRef.current) return;
      const rect = rightPanelRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftWidthPct(Math.max(30, Math.min(85, pct)));
    };
    const onMouseUp = () => { dividerDragging.current = false; };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const refreshRecordedSessions = useCallback(() => {
    void fetch('/api/bookmarks/sessions')
      .then((r) => r.json())
      .then((d: { sessions?: RecordedSession[] }) => {
        setRecordedSessions(d.sessions ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshRecordedSessions();
    const interval = setInterval(refreshRecordedSessions, 15_000);
    return () => clearInterval(interval);
  }, [refreshRecordedSessions]);

  // Per-session match counts for the current sidebar search query (session name/cwd + event content)
  const [searchMatchCounts, setSearchMatchCounts] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    const q = sidebarSearch.trim();
    if (!q) {
      setSearchMatchCounts(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void fetch(`/api/bookmarks/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((d: { results?: { sessionId: string; matchCount: number }[] }) => {
          if (cancelled) return;
          setSearchMatchCounts(new Map((d.results ?? []).map((r) => [r.sessionId, r.matchCount])));
        })
        .catch(() => {
          if (!cancelled) setSearchMatchCounts(new Map());
        });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [sidebarSearch]);

  const handleSelectSession = useCallback(async (sessionId: string) => {
    if (viewingSessionId === sessionId) return;
    setSelectedEvent(null);
    setViewingSession(sessionId);
    setHistoricalEvents([]);
    setShowFlowchart(false);
    try {
      const [evRes, metricsRes] = await Promise.all([
        fetch(`/api/bookmarks/sessions/${sessionId}/events`),
        fetch(`/api/bookmarks/sessions/${sessionId}/time-metrics`),
      ]);
      const evData = await evRes.json() as { events?: Parameters<typeof setHistoricalEvents>[0] };
      const metricsData = metricsRes.ok ? await metricsRes.json() as SessionTimeMetrics : null;
      setHistoricalEvents(evData.events ?? []);
      setSessionTimeMetrics(metricsData);
    } catch {
      setHistoricalEvents([]);
      setSessionTimeMetrics(null);
    }
  }, [viewingSessionId, setViewingSession, setHistoricalEvents, setSessionTimeMetrics, setSelectedEvent]);

  const handleCloseSession = useCallback(() => {
    setSelectedEvent(null);
    setInvestigationOpen(false);
    setViewingSession(null);
    setHistoricalEvents([]);
    setSessionTimeMetrics(null);
    setShowFlowchart(false);
  }, [setViewingSession, setHistoricalEvents, setSessionTimeMetrics, setSelectedEvent, setInvestigationOpen]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await fetch(`/api/bookmarks/sessions/${sessionId}`, { method: 'DELETE' });
      if (viewingSessionId === sessionId) handleCloseSession();
      refreshRecordedSessions();
    } catch {
      // ignore
    } finally {
      setDeleteConfirmSessionId(null);
    }
  }, [viewingSessionId, handleCloseSession, refreshRecordedSessions]);

  const handleQuickBookmark = useCallback(async (sessionId: string) => {
    const session = recordedSessions.find((s) => s.sessionId === sessionId);
    const name = sessionDisplayName(session?.sessionName, session?.cwd, sessionId);
    await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, name, folderId: null }),
    }).catch(() => {});
  }, [recordedSessions]);

  const hasSidebarSearch = sidebarSearch.trim().length > 0;

  // While the server round-trip for match counts is pending, fall back to a local name/cwd
  // substring match so the list doesn't flash to "no results" during the debounce window.
  const matchesLocally = useCallback((s: RecordedSession) => {
    const q = sidebarSearch.toLowerCase();
    return (s.sessionName ?? '').toLowerCase().includes(q) ||
      (s.cwd ?? '').toLowerCase().includes(q) ||
      s.sessionId.toLowerCase().includes(q);
  }, [sidebarSearch]);

  const sessionMatches = useCallback((s: RecordedSession) => {
    if (!hasSidebarSearch) return true;
    if (searchMatchCounts) return searchMatchCounts.has(s.sessionId);
    return matchesLocally(s);
  }, [hasSidebarSearch, searchMatchCounts, matchesLocally]);

  const matchLabel = useCallback((sessionId: string): string | null => {
    if (!hasSidebarSearch || !searchMatchCounts) return null;
    const count = searchMatchCounts.get(sessionId) ?? 0;
    return `${count} ${count === 1 ? 'match' : 'matches'}`;
  }, [hasSidebarSearch, searchMatchCounts]);

  // Filtered sessions for sidebar
  const filteredSessions = useMemo(() => {
    let list = recordedSessions;
    if (filter === 'bookmarked') {
      list = list.filter((s) => bookmarkedSessionIds.has(s.sessionId));
    }
    if (hasSidebarSearch) {
      list = list.filter(sessionMatches);
    }
    return list;
  }, [recordedSessions, filter, bookmarkedSessionIds, hasSidebarSearch, sessionMatches]);

  // Sessions in each folder (bookmarks → recorded session), with bookmark id for reordering.
  // Computed once per folder (not per render call site) since it's looked up from
  // both a `.map` and a `.some` check below.
  const folderSessionsMap = useMemo(() => {
    const map = new Map<string, { session: RecordedSession; bookmarkId: string }[]>();
    for (const folder of sortedFolders) {
      map.set(folder.id, bookmarks
        .filter((b) => b.folderId === folder.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((b) => {
          const session = recordedSessions.find((s) => s.sessionId === b.sessionId);
          return session ? { session, bookmarkId: b.id } : null;
        })
        .filter((item): item is { session: RecordedSession; bookmarkId: string } => item !== null)
        .filter((item) => sessionMatches(item.session)));
    }
    return map;
  }, [sortedFolders, bookmarks, recordedSessions, sessionMatches]);

  const unfiledBookmarkedSessions = useMemo(() => {
    return bookmarks
      .filter((b) => b.folderId === null)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((b) => {
        const session = recordedSessions.find((s) => s.sessionId === b.sessionId);
        return session ? { session, bookmarkId: b.id } : null;
      })
      .filter((item): item is { session: RecordedSession; bookmarkId: string } => item !== null)
      .filter((item) => sessionMatches(item.session));
  }, [bookmarks, recordedSessions, sessionMatches]);

  // Folder CRUD — the server already supports all of this (create/rename/delete/
  // reorder), it was just never wired up in the UI.
  const { handleCreateFolder, handleRenameFolder, handleDeleteFolder, persistFolderOrder } =
    useFolderCrud('/api/bookmarks/folders');
  const { items: orderedFolders, reorder: reorderFolders } = useOptimisticOrder(sortedFolders, (f) => f.id, persistFolderOrder);
  const {
    dragOverId: folderDragOverId,
    handleDragStart: handleFolderDragStart, handleDragOver: handleFolderDragOver, handleDragEnd: handleFolderDragEnd,
  } = useDragReorder(reorderFolders);

  // Cross-container item drag (sessions ↔ folders/Unfiled/History). Dropping an
  // unbookmarked History row onto a folder or Unfiled creates the bookmark
  // there directly; dropping an already-bookmarked row moves it; dropping
  // within its own container reorders it.
  const handleFolderDrop = useCallback((source: FolderDragSource, target: FolderDropTarget) => {
    const targetFolderId = target.containerId === 'unfiled' ? null : target.containerId;

    if (!source.bookmarked) {
      const session = recordedSessions.find((s) => s.sessionId === source.id);
      const name = sessionDisplayName(session?.sessionName, session?.cwd, source.id);
      void fetch('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: source.id, name, folderId: targetFolderId }),
      }).catch(() => {});
      return;
    }

    if (source.containerId === target.containerId) {
      const currentIds = target.containerId === 'unfiled'
        ? unfiledBookmarkedSessions.map((item) => item.bookmarkId)
        : (folderSessionsMap.get(target.containerId) ?? []).map((item) => item.bookmarkId);
      const newIds = reorderIds(currentIds, source.id, target.beforeId);
      void fetch('/api/bookmarks/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: targetFolderId, ids: newIds }),
      }).catch(() => {});
    } else {
      void fetch(`/api/bookmarks/${source.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: targetFolderId }),
      }).catch(() => {});
    }
  }, [recordedSessions, unfiledBookmarkedSessions, folderSessionsMap]);

  const {
    draggedId: draggedItemId, dragOverContainerId, dragOverItemId,
    handleDragStart: handleItemDragStart, handleDragOverItem, handleDragOverContainer, handleDragEnd: handleItemDragEnd,
  } = useFolderDrag(handleFolderDrop);

  // Keyboard navigation for the HISTORY list
  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (filteredSessions.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, filteredSessions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        if (focusedIndex >= 0 && focusedIndex < filteredSessions.length) {
          e.preventDefault();
          void handleSelectSession(filteredSessions[focusedIndex].sessionId);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCloseSession();
      }
    };
    sidebar.addEventListener('keydown', onKeyDown);
    return () => sidebar.removeEventListener('keydown', onKeyDown);
  }, [filteredSessions, focusedIndex, handleSelectSession, handleCloseSession]);

  // Reset focused index when filtered list changes
  useEffect(() => {
    setFocusedIndex(-1);
  }, [filter, sidebarSearch]);

  const viewingSession = recordedSessions.find((s) => s.sessionId === viewingSessionId);
  const archivedDate = viewingSession ? formatDateShort(viewingSession.lastSeen) : undefined;

  const sectionLabel = SECTION_LABEL_STYLE;

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg)' }}>
      {/* Delete confirmation */}
      {deleteConfirmSessionId && (
        <ConfirmDialog
          title="Delete session?"
          body="This will permanently delete all events for this session from history. This cannot be undone."
          onCancel={() => setDeleteConfirmSessionId(null)}
          onConfirm={() => void handleDeleteSession(deleteConfirmSessionId)}
        />
      )}

      {/* Delete folder confirmation */}
      {deleteConfirmFolderId && (
        <ConfirmDialog
          title="Delete folder?"
          body="Bookmarks inside this folder become Unfiled — they aren't deleted."
          onCancel={() => setDeleteConfirmFolderId(null)}
          onConfirm={() => handleDeleteFolder(deleteConfirmFolderId, () => setDeleteConfirmFolderId(null))}
        />
      )}

      {/* Left sidebar */}
      <div
        ref={sidebarRef}
        tabIndex={0}
        style={{
          width: 280, flexShrink: 0,
          background: 'var(--bg-raised)',
          borderRight: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          outline: 'none',
        }}
      >
        {/* Search */}
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SearchInput
            value={sidebarSearch}
            onChange={setSidebarSearch}
            placeholder="Search all sessions + content…"
          />
          {hasSidebarSearch && searchMatchCounts && (
            <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--warn)' }}>
              {Array.from(searchMatchCounts.values()).reduce((a, b) => a + b, 0)} matches · {searchMatchCounts.size} session{searchMatchCounts.size === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {/* All / Bookmarked filter */}
        <div style={{
          display: 'flex', padding: '6px 12px',
          borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <SegmentedControl
            options={[{ value: 'all', label: 'All' }, { value: 'bookmarked', label: 'Bookmarked' }]}
            value={filter}
            onChange={setFilter}
          />
        </div>

        {/* Session list */}
        <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
          {/* Bookmark folders (create/rename/delete/reorder + drag sessions in) */}
          {filter === 'all' && (
            <>
              <div style={sectionLabel}>Bookmarked</div>
              {orderedFolders.map((folder) => {
                const items = folderSessionsMap.get(folder.id) ?? [];
                return (
                  <SidebarFolder
                    key={folder.id}
                    folderId={folder.id}
                    name={folder.name}
                    items={items}
                    viewingSessionId={viewingSessionId}
                    liveSessionIds={liveSessionIds}
                    matchLabel={matchLabel}
                    onSelect={handleSelectSession}
                    onRename={(name) => handleRenameFolder(folder.id, name)}
                    onDelete={() => setDeleteConfirmFolderId(folder.id)}
                    draggedItemId={draggedItemId}
                    dragOverContainerId={dragOverContainerId}
                    dragOverItemId={dragOverItemId}
                    onItemDragStart={handleItemDragStart}
                    onItemDragOverItem={handleDragOverItem}
                    onItemDragOverContainer={handleDragOverContainer}
                    onItemDragEnd={handleItemDragEnd}
                    isFolderDragOver={folderDragOverId === folder.id}
                    onFolderDragStart={() => handleFolderDragStart(folder.id)}
                    onFolderDragOver={() => handleFolderDragOver(folder.id)}
                    onFolderDragEnd={handleFolderDragEnd}
                  />
                );
              })}

              <div
                onDragOver={(e) => { e.preventDefault(); handleDragOverContainer('unfiled'); }}
                style={{
                  ...sectionLabel, paddingTop: 4,
                  background: dragOverContainerId === 'unfiled' && dragOverItemId === null ? 'var(--bg-selected)' : undefined,
                }}
              >
                Unfiled
              </div>
              {unfiledBookmarkedSessions.length === 0 && (
                <div
                  onDragOver={(e) => { e.preventDefault(); handleDragOverContainer('unfiled'); }}
                  style={{ padding: '4px 12px', fontSize: 10, color: 'var(--text-faint)', fontStyle: 'italic' }}
                >
                  Drop sessions here
                </div>
              )}
              {unfiledBookmarkedSessions.map(({ session, bookmarkId }) => (
                <SidebarSessionRow
                  key={session.sessionId}
                  session={session}
                  isSelected={viewingSessionId === session.sessionId}
                  isFocused={false}
                  isLive={liveSessionIds.has(session.sessionId)}
                  isBookmarked
                  matchLabel={matchLabel(session.sessionId)}
                  isDragOver={draggedItemId !== bookmarkId && dragOverContainerId === 'unfiled' && dragOverItemId === bookmarkId}
                  onSelect={handleSelectSession}
                  onDelete={() => setDeleteConfirmSessionId(session.sessionId)}
                  onDragStart={() => handleItemDragStart({ id: bookmarkId, containerId: 'unfiled', bookmarked: true })}
                  onDragOver={() => handleDragOverItem('unfiled', bookmarkId)}
                  onDragEnd={handleItemDragEnd}
                />
              ))}

              <NewFolderRow onCreate={handleCreateFolder} />
            </>
          )}

          {/* History — not a drop target (dropping a bookmark/folder drag here should
              no-op, not silently apply whatever folder/Unfiled was last hovered before
              the pointer crossed into this section). Claiming 'history' here reuses the
              same-named guard in useFolderDrag.handleDragEnd. */}
          <div onDragOver={(e) => { e.preventDefault(); handleDragOverContainer('history'); }}>
            {filteredSessions.length > 0 && (
              <>
                <div style={sectionLabel}>History</div>
                {filteredSessions.map((s, idx) => (
                  <SidebarSessionRow
                    key={s.sessionId}
                    session={s}
                    isSelected={viewingSessionId === s.sessionId}
                    isFocused={focusedIndex === idx}
                    isLive={liveSessionIds.has(s.sessionId)}
                    isBookmarked={bookmarkedSessionIds.has(s.sessionId)}
                    matchLabel={matchLabel(s.sessionId)}
                    onSelect={handleSelectSession}
                    onBookmark={() => void handleQuickBookmark(s.sessionId)}
                    onDelete={() => setDeleteConfirmSessionId(s.sessionId)}
                    onDragStart={() => handleItemDragStart({
                      id: bookmarkIdForSession(s.sessionId) ?? s.sessionId,
                      containerId: 'history',
                      bookmarked: bookmarkedSessionIds.has(s.sessionId),
                    })}
                    onDragEnd={handleItemDragEnd}
                  />
                ))}
              </>
            )}

            {filteredSessions.length === 0 && (
              <div style={{
                padding: '32px 16px', textAlign: 'center',
                fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-ui)',
              }}>
                {sidebarSearch ? 'No sessions match your search.' : 'No recorded sessions yet.'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right panel */}
      <div ref={rightPanelRef} style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        {viewingSessionId ? (
          <>
            {/* EventStream / Flowchart in archived mode */}
            <div style={{
              width: investigationOpen ? `${leftWidthPct}%` : '100%',
              display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0,
              position: 'relative',
            }}>
              {/* Session header row */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '5px 12px', borderBottom: '1px solid var(--border)',
                background: 'var(--bg-raised)', flexShrink: 0, gap: 8,
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span style={{
                    fontSize: 12, fontWeight: 600, color: 'var(--text)',
                    fontFamily: 'var(--font-ui)', display: 'block',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {bookmarks.find((b) => b.sessionId === viewingSessionId)?.name
                      ?? sessionDisplayName(viewingSession?.sessionName, viewingSession?.cwd, viewingSessionId)}
                  </span>
                  {viewingSession?.cwd && (
                    <span style={{
                      fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
                      display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {viewingSession.cwd}
                    </span>
                  )}
                </div>

                {/* Flowchart button */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  <button
                    onClick={() => setShowFlowchart((v) => !v)}
                    title={showFlowchart ? 'Show event log' : 'Show flowchart'}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '3px 8px', fontSize: 10, borderRadius: 4,
                      fontFamily: 'var(--font-mono)',
                      color: showFlowchart ? 'var(--text)' : 'var(--text-faint)',
                      background: showFlowchart ? 'var(--bg-selected)' : 'transparent',
                      border: showFlowchart ? '1px solid var(--border-strong)' : '1px solid var(--border)',
                      cursor: 'pointer',
                      transition: 'color 0.1s, background 0.1s, border-color 0.1s',
                    }}
                    onMouseEnter={(e) => {
                      if (!showFlowchart) e.currentTarget.style.color = 'var(--text-muted)';
                    }}
                    onMouseLeave={(e) => {
                      if (!showFlowchart) e.currentTarget.style.color = 'var(--text-faint)';
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M6 3.5A2.5 2.5 0 0 1 8.5 1h3A2.5 2.5 0 0 1 14 3.5v3A2.5 2.5 0 0 1 11.5 9h-.5v2.5a2.5 2.5 0 0 1-2.5 2.5h-3A2.5 2.5 0 0 1 3 11.5v-.5H.5a.5.5 0 0 1 0-1H3V9.5a2.5 2.5 0 0 1 2.5-2.5H6V3.5Zm2.5 5h-3A1.5 1.5 0 0 0 4 10v1.5A1.5 1.5 0 0 0 5.5 13h3A1.5 1.5 0 0 0 10 11.5V10a1.5 1.5 0 0 0-1.5-1.5Zm0-7h-3A1.5 1.5 0 0 0 5 3.5V7h1V5.5A1.5 1.5 0 0 1 7.5 4h4A1.5 1.5 0 0 1 13 5.5v3A1.5 1.5 0 0 1 11.5 10H11V8.5H11.5A1.5 1.5 0 0 0 13 7V3.5A1.5 1.5 0 0 0 11.5 2h-3Z"/>
                    </svg>
                    Flow
                  </button>
                </div>

                <button
                  onClick={handleCloseSession}
                  title="Close session"
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-faint)', fontSize: 16, lineHeight: 1, padding: '2px 4px',
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}
                >
                  ×
                </button>
              </div>

              {/* Content: flowchart or event stream */}
              {showFlowchart ? (
                <div style={{ flex: 1, minHeight: 0 }}>
                  <Suspense fallback={
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-faint)', fontSize: 11 }}>
                      Loading…
                    </div>
                  }>
                    <FlowchartView events={historicalEvents} />
                  </Suspense>
                </div>
              ) : (
                <EventStream onSend={onSend} archived archivedDate={archivedDate} />
              )}
            </div>

            {/* Drag divider + InvestigationPanel */}
            {investigationOpen && (
              <>
                <div
                  style={{
                    width: 4, flexShrink: 0, cursor: 'col-resize',
                    background: 'var(--border)',
                    transition: 'background 0.15s',
                  }}
                  onMouseDown={() => { dividerDragging.current = true; }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(88,166,255,0.5)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--border)')}
                />
                <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
                  <InvestigationPanel onSend={onSend} />
                </div>
              </>
            )}
          </>
        ) : (
          /* Empty state */
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 12, padding: '0 32px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 32, opacity: 0.15 }}>◷</div>
            <p style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 500, color: 'var(--text)', margin: 0 }}>
              Select a session
            </p>
            <p style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
              Choose a session from the sidebar to view its event history.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SidebarFolder ────────────────────────────────────────────────────────────

interface SidebarFolderProps {
  folderId: string;
  name: string;
  items: { session: RecordedSession; bookmarkId: string }[];
  viewingSessionId: string | null;
  liveSessionIds: Set<string>;
  matchLabel: (sessionId: string) => string | null;
  onSelect: (id: string) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  draggedItemId: string | null;
  dragOverContainerId: string | null;
  dragOverItemId: string | null;
  onItemDragStart: (source: FolderDragSource) => void;
  onItemDragOverItem: (containerId: string, itemId: string) => void;
  onItemDragOverContainer: (containerId: string) => void;
  onItemDragEnd: () => void;
  isFolderDragOver: boolean;
  onFolderDragStart: () => void;
  onFolderDragOver: () => void;
  onFolderDragEnd: () => void;
}

function SidebarFolder({
  folderId, name, items, viewingSessionId, liveSessionIds, matchLabel, onSelect,
  onRename, onDelete,
  draggedItemId, dragOverContainerId, dragOverItemId,
  onItemDragStart, onItemDragOverItem, onItemDragOverContainer, onItemDragEnd,
  isFolderDragOver, onFolderDragStart, onFolderDragOver, onFolderDragEnd,
}: SidebarFolderProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <CollapsibleFolderHeader
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        name={name}
        count={items.length}
        onRename={onRename}
        onDelete={onDelete}
        draggable
        isDragOver={isFolderDragOver || (dragOverContainerId === folderId && dragOverItemId === null)}
        onDragStart={onFolderDragStart}
        onDragOver={() => { onFolderDragOver(); onItemDragOverContainer(folderId); }}
        onDragEnd={onFolderDragEnd}
      />
      {expanded && items.length === 0 && (
        <div
          onDragOver={(e) => { e.preventDefault(); onItemDragOverContainer(folderId); }}
          style={{ padding: '4px 20px', fontSize: 10, color: 'var(--text-faint)', fontStyle: 'italic' }}
        >
          Drop sessions here
        </div>
      )}
      {expanded && items.map(({ session, bookmarkId }) => (
        <SidebarSessionRow
          key={session.sessionId}
          session={session}
          isSelected={viewingSessionId === session.sessionId}
          isFocused={false}
          isLive={liveSessionIds.has(session.sessionId)}
          isBookmarked
          indent
          matchLabel={matchLabel(session.sessionId)}
          isDragOver={draggedItemId !== bookmarkId && dragOverContainerId === folderId && dragOverItemId === bookmarkId}
          onSelect={onSelect}
          onDragStart={() => onItemDragStart({ id: bookmarkId, containerId: folderId, bookmarked: true })}
          onDragOver={() => onItemDragOverItem(folderId, bookmarkId)}
          onDragEnd={onItemDragEnd}
        />
      ))}
    </div>
  );
}

// ─── SidebarSessionRow ────────────────────────────────────────────────────────

interface SidebarSessionRowProps {
  session: RecordedSession;
  isSelected: boolean;
  isFocused: boolean;
  isLive: boolean;
  isBookmarked: boolean;
  indent?: boolean;
  isDragOver?: boolean;
  matchLabel?: string | null;
  onSelect: (id: string) => void;
  onBookmark?: () => void;
  onDelete?: () => void;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDragEnd?: () => void;
}

function SidebarSessionRow({
  session, isSelected, isFocused, isLive, isBookmarked, indent = false,
  isDragOver = false, matchLabel, onSelect, onBookmark, onDelete,
  onDragStart, onDragOver, onDragEnd,
}: SidebarSessionRowProps) {
  const [hovered, setHovered] = useState(false);
  const label = sessionDisplayName(session.sessionName, session.cwd, session.sessionId);
  const draggable = !!onDragStart;

  return (
    <div
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart?.(); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDragOver?.(); }}
      onDragEnd={onDragEnd}
      style={{
        borderTop: isDragOver ? '2px solid var(--info)' : '2px solid transparent',
        transition: 'border-color 0.1s',
      }}
    >
    <button
      onClick={() => onSelect(session.sessionId)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={session.cwd || session.sessionId}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 6,
        padding: indent ? '5px 12px 5px 20px' : '5px 12px',
        background: isSelected ? 'var(--bg-selected)' : isFocused ? 'var(--bg-card)' : hovered ? 'var(--bg-card)' : 'transparent',
        border: 'none', cursor: 'pointer', textAlign: 'left',
        borderLeft: isSelected ? '2px solid var(--accent)' : isFocused ? '2px solid var(--border-strong)' : '2px solid transparent',
        outline: isFocused ? '1px solid var(--border-strong)' : 'none',
        outlineOffset: -1,
        transition: 'background 0.1s',
      }}
    >
      {/* Drag handle */}
      {draggable && (
        <span style={{
          fontSize: 11, color: 'var(--text-faint)', cursor: 'grab', flexShrink: 0,
          opacity: hovered ? 0.7 : 0.25, userSelect: 'none', lineHeight: 1,
        }}>
          ⠿
        </span>
      )}

      {/* Live dot */}
      {isLive && (
        <span style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: 'var(--ok)', boxShadow: '0 0 6px var(--ok)',
        }} />
      )}

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 11, fontWeight: 500, color: 'var(--text)',
          fontFamily: 'var(--font-ui)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {label}
        </div>
        <div style={{
          fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
          display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap',
        }}>
          <span>{formatDateShort(session.lastSeen)}</span>
          {session.sessionModelDisplayName && (
            <span style={{ color: 'var(--info)' }}>· {session.sessionModelDisplayName}</span>
          )}
          {session.eventCount !== undefined && session.eventCount > 0 && (
            <span style={{ color: 'var(--text-faint)' }}>· {session.eventCount} events</span>
          )}
        </div>
      </div>

      {/* Match count (visible while a search query is active) */}
      {matchLabel && (
        <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--warn)', flexShrink: 0 }}>
          {matchLabel}
        </span>
      )}

      {/* Actions (visible on hover) */}
      <div style={{ display: 'flex', gap: 3, flexShrink: 0, opacity: hovered ? 1 : 0, transition: 'opacity 0.1s' }}>
        {!isBookmarked && onBookmark && (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); onBookmark(); }}
            title="Bookmark"
            style={{ fontSize: 10, color: 'var(--text-faint)', cursor: 'pointer', padding: '1px 3px' }}
          >
            🔖
          </span>
        )}
        {isBookmarked && (
          <span style={{ fontSize: 10, color: 'var(--warn)', opacity: 0.7 }} title="Bookmarked">🔖</span>
        )}
        {onDelete && (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete session"
            style={{ fontSize: 10, color: 'var(--text-faint)', cursor: 'pointer', padding: '1px 3px' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--error)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}
          >
            ✕
          </span>
        )}
      </div>
    </button>
    </div>
  );
}
