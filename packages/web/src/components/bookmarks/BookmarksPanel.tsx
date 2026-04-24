import React, { useState, useCallback, useEffect, useRef, useMemo, Suspense, lazy } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { useSearchStore, eventPassesFilters } from '../../stores/searchStore.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import type { RecordedSession, QAEntry, SessionTimeMetrics } from '../../lib/types.js';
import { BookmarkEmptyState } from './BookmarkEmptyState.js';
import { FolderItem } from './FolderItem.js';
import { BookmarkItem } from './BookmarkItem.js';
import { HistoricalEventStream } from './HistoricalEventStream.js';
import { InvestigationPanel } from '../layout/InvestigationPanel.js';
import { SessionLaymansTerms } from '../shared/SessionLaymansTerms.js';
import { SearchBar } from '../search/SearchBar.js';
import { SearchResults } from '../search/SearchResults.js';
import { EventTypeFilterBar } from '../search/EventTypeFilterBar.js';

const FlowchartView = lazy(() => import('../flowchart/FlowchartView.js').then(m => ({ default: m.FlowchartView })));
const TimelineView = lazy(() => import('../flowchart/TimelineView.js').then(m => ({ default: m.TimelineView })));

interface BookmarksPanelProps {
  onSend: (msg: ClientMessage) => void;
}

function getSessionLabel(cwd: string, sessionId: string): string {
  if (cwd) return cwd.split('/').filter(Boolean).pop() ?? cwd;
  return sessionId.slice(0, 8);
}

export function BookmarksPanel({ onSend }: BookmarksPanelProps) {
  const {
    bookmarksOpen,
    setBookmarksOpen,
    bookmarkFolders,
    bookmarks,
    config,
    sessions,
    viewingSessionId,
    setViewingSession,
    historicalEvents,
    setHistoricalEvents,
    investigatedSessions,
    markSessionInvestigated,
  } = useSessionStore();

  const setSessionTimeMetrics = useSessionStore((s) => s.setSessionTimeMetrics);

  const [recordedSessions, setRecordedSessions] = useState<RecordedSession[]>([]);
  const [qaEntries, setQaEntries] = useState<QAEntry[]>([]);
  const [investigatingEventId, setInvestigatingEventId] = useState<string | null>(null);
  const [historicalSessionSummary, setHistoricalSessionSummary] = useState<string | null>(null);
  const [historicalSummaryHistory, setHistoricalSummaryHistory] = useState<Array<{ summary: string; generatedAt: number }>>([]);
  const [historicalSummaryError, setHistoricalSummaryError] = useState<string | null>(null);
  const [isSummarizingHistorical, setIsSummarizingHistorical] = useState(false);
  const [showAddBookmark, setShowAddBookmark] = useState(false);
  const [newBookmarkName, setNewBookmarkName] = useState('');
  const [newBookmarkSessionId, setNewBookmarkSessionId] = useState('');
  const [newBookmarkFolderId, setNewBookmarkFolderId] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [savingSessionId, setSavingSessionId] = useState<string | null>(null);
  const [savedSessionIds, setSavedSessionIds] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState<string | null>(null);
  const [historicalFlowchartOpen, setHistoricalFlowchartOpen] = useState(false);
  const [historicalViewMode, setHistoricalViewMode] = useState<'graph' | 'timeline'>('graph');

  const recordingEnabled = config?.sessionRecording ?? false;

  const { searchResults, eventTypeFilters, setEventTypeFilters, clearSearch } = useSearchStore();

  // Apply event type filters to historical events for session viewing
  // (must be above the early return to maintain stable hook ordering)
  const filteredHistoricalEvents = useMemo(
    () => historicalEvents.filter((e) => eventPassesFilters(e, eventTypeFilters, historicalEvents)),
    [historicalEvents, eventTypeFilters]
  );

  const refreshRecordedSessions = useCallback(() => {
    void fetch('/api/bookmarks/sessions')
      .then((r) => r.json())
      .then((d: { sessions?: RecordedSession[] }) => {
        const list = d.sessions ?? [];
        setRecordedSessions(list);
        setSavedSessionIds(new Set(list.map((s) => s.sessionId)));
      })
      .catch(() => {});
  }, []);

  // Load recorded sessions when panel opens, and poll while open
  useEffect(() => {
    if (!bookmarksOpen) return;
    refreshRecordedSessions();
    const interval = setInterval(refreshRecordedSessions, 10_000);
    return () => clearInterval(interval);
  }, [bookmarksOpen, refreshRecordedSessions]);

  // Snapshot current in-memory session to SQLite
  const handleSaveCurrentSession = useCallback(async (sessionId: string) => {
    setSavingSessionId(sessionId);
    try {
      await fetch('/api/bookmarks/sessions/save-current', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      refreshRecordedSessions();
    } catch {
      // ignore
    } finally {
      setSavingSessionId(null);
    }
  }, [refreshRecordedSessions]);

  // Import events from a saved /api/events JSON file
  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so the same file can be re-selected if needed
    e.target.value = '';
    setImporting(true);
    setImportResult(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { events?: unknown[]; total?: number } | unknown[];
      // Accept both the raw array and the /api/events response shape { events: [...] }
      const events = Array.isArray(parsed) ? parsed : (parsed as { events?: unknown[] }).events ?? [];
      const res = await fetch('/api/bookmarks/sessions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      });
      const data = await res.json() as { ok?: boolean; importedEventCount?: number; sessionCount?: number; bookmarksCreated?: number; error?: string };
      if (!res.ok || data.error) {
        setImportResult(`Error: ${data.error ?? `HTTP ${res.status}`}`);
      } else {
        setImportResult(`Imported ${data.importedEventCount ?? 0} events across ${data.sessionCount ?? 0} session(s), created ${data.bookmarksCreated ?? 0} bookmark(s).`);
        refreshRecordedSessions();
      }
    } catch (err) {
      setImportResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
    }
  }, [refreshRecordedSessions]);

  // Load historical events when a session is selected
  const handleSelectSession = useCallback(async (sessionId: string) => {
    if (viewingSessionId === sessionId) return;
    setInvestigatingEventId(null);
    setHistoricalSessionSummary(null);
    setHistoricalSummaryHistory([]);
    setHistoricalSummaryError(null);
    setHistoricalFlowchartOpen(false);
    setViewingSession(sessionId);
    try {
      const [evRes, qaRes, metricsRes] = await Promise.all([
        fetch(`/api/bookmarks/sessions/${sessionId}/events`),
        fetch(`/api/bookmarks/sessions/${sessionId}/qa`),
        fetch(`/api/bookmarks/sessions/${sessionId}/time-metrics`),
      ]);
      const evData = await evRes.json() as { events?: Parameters<typeof setHistoricalEvents>[0] };
      const qaData = await qaRes.json() as { qa?: QAEntry[] };
      const metricsData = metricsRes.ok ? await metricsRes.json() as SessionTimeMetrics : null;
      setHistoricalEvents(evData.events ?? []);
      setQaEntries(qaData.qa ?? []);
      setSessionTimeMetrics(metricsData);
    } catch {
      setHistoricalEvents([]);
      setQaEntries([]);
      setSessionTimeMetrics(null);
    }
  }, [viewingSessionId, setViewingSession, setHistoricalEvents, setSessionTimeMetrics]);

  const handleCloseSession = useCallback(() => {
    setViewingSession(null);
    setQaEntries([]);
    setInvestigatingEventId(null);
    setHistoricalSessionSummary(null);
    setHistoricalSummaryHistory([]);
    setHistoricalSummaryError(null);
    setSessionTimeMetrics(null);
    setHistoricalFlowchartOpen(false);
  }, [setViewingSession, setSessionTimeMetrics]);

  const handleGenerateHistoricalSummary = useCallback(async (sessionId: string) => {
    markSessionInvestigated(sessionId);
    setIsSummarizingHistorical(true);
    setHistoricalSummaryError(null);
    try {
      const res = await fetch('/api/sessions/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json() as { summary?: string; error?: string };
      if (res.ok && data.summary) {
        setHistoricalSessionSummary(data.summary);
        setHistoricalSummaryHistory((prev) => [...prev, { summary: data.summary!, generatedAt: Date.now() }]);
      } else {
        setHistoricalSummaryError(data.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setHistoricalSummaryError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setIsSummarizingHistorical(false);
    }
  }, [markSessionInvestigated]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await fetch(`/api/bookmarks/sessions/${sessionId}`, { method: 'DELETE' });
      if (viewingSessionId === sessionId) {
        setViewingSession(null);
        setQaEntries([]);
        setInvestigatingEventId(null);
      }
      refreshRecordedSessions();
    } catch {
      // ignore
    } finally {
      setDeleteConfirmSessionId(null);
    }
  }, [viewingSessionId, setViewingSession, refreshRecordedSessions]);

  // Open a session from search results
  const handleOpenSessionFromSearch = useCallback(async (sessionId: string) => {
    clearSearch();
    await handleSelectSession(sessionId);
  }, [clearSearch, handleSelectSession]);

  // Bookmark CRUD
  const handleRenameBookmark = useCallback(async (id: string, name: string) => {
    await fetch(`/api/bookmarks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => {});
  }, []);

  const handleMoveBookmark = useCallback(async (id: string, folderId: string | null) => {
    await fetch(`/api/bookmarks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId }) }).catch(() => {});
  }, []);

  const handleDeleteBookmark = useCallback(async (id: string) => {
    await fetch(`/api/bookmarks/${id}`, { method: 'DELETE' }).catch(() => {});
  }, []);

  const handleRenameFolder = useCallback(async (id: string, name: string) => {
    await fetch(`/api/bookmarks/folders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => {});
  }, []);

  const handleDeleteFolder = useCallback(async (id: string) => {
    await fetch(`/api/bookmarks/folders/${id}`, { method: 'DELETE' }).catch(() => {});
  }, []);

  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    await fetch('/api/bookmarks/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => {});
    setNewFolderName('');
    setShowNewFolder(false);
  }, [newFolderName]);

  const handleCreateBookmark = useCallback(async () => {
    if (!newBookmarkSessionId || !newBookmarkName.trim()) return;
    await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: newBookmarkSessionId, name: newBookmarkName.trim(), folderId: newBookmarkFolderId }),
    }).catch(() => {});
    setNewBookmarkName('');
    setNewBookmarkSessionId('');
    setNewBookmarkFolderId(null);
    setShowAddBookmark(false);
  }, [newBookmarkSessionId, newBookmarkName, newBookmarkFolderId]);

  const handleQuickBookmark = useCallback(async (sessionId: string) => {
    const session = recordedSessions.find((s) => s.sessionId === sessionId);
    const name = session?.sessionName || getSessionLabel(session?.cwd ?? '', sessionId);
    await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, name, folderId: null }),
    }).catch(() => {});
  }, [recordedSessions]);

  if (!bookmarksOpen) return null;

  const folderBookmarks = (folderId: string) => bookmarks.filter((b) => b.folderId === folderId).sort((a, b) => a.sortOrder - b.sortOrder);
  const unfiledBookmarks = bookmarks.filter((b) => b.folderId === null).sort((a, b) => a.sortOrder - b.sortOrder);
  const sortedFolders = [...bookmarkFolders].sort((a, b) => a.sortOrder - b.sortOrder);
  const hasContent = bookmarks.length > 0;

  // Live sessions not yet saved to DB
  const unsavedLiveSessions = sessions.filter((s) => !savedSessionIds.has(s.sessionId));

  // All sessions available to bookmark (recorded + newly saved)
  const bookmarkedSessionIds = new Set(bookmarks.map((b) => b.sessionId));
  const unbookmarkedSessions = recordedSessions.filter((s) => !bookmarkedSessionIds.has(s.sessionId));
  const liveSessionIds = new Set(sessions.map((s) => s.sessionId));

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Delete confirmation dialog */}
      {deleteConfirmSessionId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
          <div className="bg-[#161b22] border border-[#30363d] rounded-lg shadow-2xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-sm font-semibold text-[#e6edf3] mb-2">Delete session?</h3>
            <p className="text-xs text-[#8b949e] mb-5">
              This will permanently delete all events and Q&amp;A for this session from history. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirmSessionId(null)}
                className="px-3 py-1.5 text-xs rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDeleteSession(deleteConfirmSessionId)}
                className="px-3 py-1.5 text-xs rounded bg-[#da3633] border border-[#f85149] text-white hover:bg-[#f85149] transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Overlay */}
      <div data-bookmarks-overlay className="fixed inset-0 bg-black/50" onClick={() => setBookmarksOpen(false)} />

      {/* Panel */}
      <div className={`relative flex w-full mx-auto my-0 h-full bg-[#0d1117] shadow-2xl ${investigatingEventId ? 'max-w-full' : 'max-w-5xl'}`}>
        {/* Left: bookmark tree */}
        <div data-bookmarks-sidebar className="w-72 shrink-0 bg-[#161b22] border-r border-[#30363d] flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d]">
            <h2 className="text-sm font-semibold text-[#e6edf3]">Sessions</h2>
            <button
              onClick={() => setBookmarksOpen(false)}
              className="text-[#8b949e] hover:text-[#e6edf3] transition-colors text-lg leading-none"
            >
              ×
            </button>
          </div>

          {/* Search bar */}
          <SearchBar
            viewingSessionId={viewingSessionId}
            viewingSessionLabel={viewingSessionId ? (
              recordedSessions.find((s) => s.sessionId === viewingSessionId)?.sessionName
              ?? getSessionLabel(
                recordedSessions.find((s) => s.sessionId === viewingSessionId)?.cwd ?? '',
                viewingSessionId
              )
            ) : undefined}
          />

          {/* Live sessions that haven't been saved yet */}
          {unsavedLiveSessions.length > 0 && (
            <div className="border-b border-[#30363d] px-3 py-2 space-y-1.5">
              <p className="text-[10px] text-[#d29922] font-medium uppercase tracking-wider flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#d29922] animate-pulse" />
                Live — not yet saved
              </p>
              {unsavedLiveSessions.map((s) => (
                <div key={s.sessionId} className="flex items-center justify-between gap-2">
                  <span className="text-xs text-[#8b949e] truncate flex-1" title={s.cwd || s.sessionId}>
                    {s.sessionName || getSessionLabel(s.cwd, s.sessionId)}
                  </span>
                  <button
                    onClick={() => void handleSaveCurrentSession(s.sessionId)}
                    disabled={savingSessionId === s.sessionId}
                    className="shrink-0 px-2 py-0.5 text-[10px] rounded bg-[#1f6feb] border border-[#388bfd] text-white hover:bg-[#388bfd] disabled:opacity-50 transition-colors"
                    title="Snapshot this session to SQLite so it survives a container restart"
                  >
                    {savingSessionId === s.sessionId ? 'Saving...' : 'Snapshot'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Toolbar */}
          <div className="flex items-center gap-1 px-2 py-2 border-b border-[#30363d]">
            <button
              onClick={() => setShowAddBookmark(true)}
              title="Add bookmark"
              className="flex-1 px-2 py-1 text-xs rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d] transition-colors text-left"
            >
              + Bookmark
            </button>
            <button
              onClick={() => setShowNewFolder(true)}
              title="New folder"
              className="px-2 py-1 text-xs rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d] transition-colors"
            >
              📁+
            </button>
            <button
              onClick={() => importInputRef.current?.click()}
              disabled={importing}
              title="Import sessions from a saved /api/events JSON file"
              className="px-2 py-1 text-xs rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d] disabled:opacity-50 transition-colors"
            >
              {importing ? '…' : '⬆'}
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => void handleImportFile(e)}
            />
          </div>

          {/* Import result message */}
          {importResult && (
            <div className={`px-3 py-2 border-b border-[#30363d] text-[10px] leading-relaxed ${importResult.startsWith('Error') ? 'text-[#f85149]' : 'text-[#3fb950]'}`}>
              {importResult}
              <button onClick={() => setImportResult(null)} className="ml-2 text-[#484f58] hover:text-[#8b949e]">✕</button>
            </div>
          )}

          {/* New folder form */}
          {showNewFolder && (
            <div className="px-3 py-2 border-b border-[#30363d] flex gap-2">
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateFolder(); if (e.key === 'Escape') { setShowNewFolder(false); setNewFolderName(''); } }}
                placeholder="Folder name"
                className="flex-1 px-2 py-1 text-xs bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] min-w-0"
              />
              <button onClick={() => void handleCreateFolder()} className="text-xs text-[#3fb950] hover:text-[#56d364] transition-colors">✓</button>
              <button onClick={() => { setShowNewFolder(false); setNewFolderName(''); }} className="text-xs text-[#484f58] hover:text-[#8b949e] transition-colors">✕</button>
            </div>
          )}

          {/* Add bookmark form */}
          {showAddBookmark && (
            <div className="px-3 py-2 border-b border-[#30363d] space-y-2">
              <select
                value={newBookmarkSessionId}
                onChange={(e) => {
                  setNewBookmarkSessionId(e.target.value);
                  if (!newBookmarkName && e.target.value) {
                    const s = recordedSessions.find((r) => r.sessionId === e.target.value);
                    if (s?.cwd) setNewBookmarkName(s.cwd.split('/').filter(Boolean).pop() ?? e.target.value.slice(0, 8));
                  }
                }}
                className="w-full px-2 py-1 text-xs bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
              >
                <option value="">Select session...</option>
                {unbookmarkedSessions.map((s) => (
                  <option key={s.sessionId} value={s.sessionId}>
                    {s.sessionName || getSessionLabel(s.cwd, s.sessionId)} · {new Date(s.lastSeen).toLocaleDateString()}
                  </option>
                ))}
                {unbookmarkedSessions.length === 0 && (
                  <option value="" disabled>All recorded sessions are bookmarked</option>
                )}
              </select>
              <input
                value={newBookmarkName}
                onChange={(e) => setNewBookmarkName(e.target.value)}
                placeholder="Bookmark name"
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateBookmark(); if (e.key === 'Escape') setShowAddBookmark(false); }}
                className="w-full px-2 py-1 text-xs bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
              />
              {bookmarkFolders.length > 0 && (
                <select
                  value={newBookmarkFolderId ?? ''}
                  onChange={(e) => setNewBookmarkFolderId(e.target.value || null)}
                  className="w-full px-2 py-1 text-xs bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
                >
                  <option value="">No folder (Unfiled)</option>
                  {bookmarkFolders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              )}
              <div className="flex gap-2">
                <button onClick={() => void handleCreateBookmark()} disabled={!newBookmarkSessionId || !newBookmarkName.trim()} className="flex-1 px-2 py-1 text-xs rounded bg-[#238636] border border-[#2ea043] text-white hover:bg-[#2ea043] disabled:opacity-40 transition-colors">
                  Save
                </button>
                <button onClick={() => { setShowAddBookmark(false); setNewBookmarkName(''); setNewBookmarkSessionId(''); }} className="px-2 py-1 text-xs rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Bookmark tree or empty state */}
          <div className="flex-1 overflow-y-auto py-2 flex flex-col">
            <div className={hasContent ? 'flex-1' : ''}>
              {!hasContent && !recordingEnabled && recordedSessions.length === 0 ? (
                <BookmarkEmptyState recordingEnabled={false} onSend={onSend} />
              ) : hasContent ? (
                <>
                  {sortedFolders.map((folder) => (
                    <FolderItem
                      key={folder.id}
                      folder={folder}
                      bookmarks={folderBookmarks(folder.id)}
                      allFolders={sortedFolders}
                      selectedSessionId={viewingSessionId}
                      onSelectSession={(sid) => void handleSelectSession(sid)}
                      onRenameFolder={(id, name) => void handleRenameFolder(id, name)}
                      onDeleteFolder={(id) => void handleDeleteFolder(id)}
                      onRenameBookmark={(id, name) => void handleRenameBookmark(id, name)}
                      onMoveBookmark={(id, fid) => void handleMoveBookmark(id, fid)}
                      onDeleteBookmark={(id) => void handleDeleteBookmark(id)}
                    />
                  ))}

                  {unfiledBookmarks.length > 0 && (
                    <div className="mt-1">
                      {sortedFolders.length > 0 && (
                        <div className="px-3 py-1">
                          <span className="text-[10px] text-[#484f58] uppercase tracking-wider font-medium">Unfiled</span>
                        </div>
                      )}
                      {unfiledBookmarks.map((b) => (
                        <BookmarkItem
                          key={b.id}
                          bookmark={b}
                          folders={sortedFolders}
                          isSelected={viewingSessionId === b.sessionId}
                          onSelect={(sid) => void handleSelectSession(sid)}
                          onRename={(id, name) => void handleRenameBookmark(id, name)}
                          onMove={(id, fid) => void handleMoveBookmark(id, fid)}
                          onDelete={(id) => void handleDeleteBookmark(id)}
                        />
                      ))}
                    </div>
                  )}
                </>
              ) : null}
            </div>

            {/* History section — all recorded sessions, newest first */}
            {(recordingEnabled || recordedSessions.length > 0) && (
              <div className="border-t border-[#30363d] mt-2 pt-1">
                <div className="px-3 py-1.5 flex items-center gap-2">
                  <span className="text-[10px] text-[#8b949e] font-medium uppercase tracking-wider">History</span>
                  {recordingEnabled && (
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full bg-[#3fb950] animate-pulse"
                      title="Session recording active"
                    />
                  )}
                </div>
                {recordedSessions.length === 0 ? (
                  <p className="px-3 py-2 text-[11px] text-[#484f58] italic">No sessions recorded yet</p>
                ) : (
                  recordedSessions.map((s) => {
                    const isBookmarked = bookmarkedSessionIds.has(s.sessionId);
                    const isSelected = viewingSessionId === s.sessionId;
                    const isLive = liveSessionIds.has(s.sessionId);
                    const isInvestigated = investigatedSessions.has(s.sessionId);
                    return (
                      <button
                        key={s.sessionId}
                        onClick={() => void handleSelectSession(s.sessionId)}
                        className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-[#21262d] transition-colors ${isSelected ? 'bg-[#21262d]' : ''}`}
                        title={s.cwd || s.sessionId}
                      >
                        <div className="flex flex-col min-w-0 flex-1 overflow-hidden">
                          <span className="text-xs text-[#e6edf3] truncate">{s.sessionName || getSessionLabel(s.cwd, s.sessionId)}</span>
                          <span className="text-[10px] text-[#484f58]">
                            {new Date(s.lastSeen).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                            {' '}
                            {new Date(s.lastSeen).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                            {s.sessionModelDisplayName && (
                              <span className="text-[#58a6ff]"> · {s.sessionModelDisplayName}</span>
                            )}
                          </span>
                        </div>
                        <div className="shrink-0 flex items-center gap-1">
                          {isLive && (
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#3fb950] animate-pulse" title="Active" />
                          )}
                          {isInvestigated && (
                            <span className="text-[10px] text-[#79c0ff]" title="Session manually investigated">⊙</span>
                          )}
                          {isBookmarked && (
                            <span className="text-[10px] text-[#d29922]" title="Bookmarked">🔖</span>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: search results, session view, or empty state */}
        <div className="flex-1 flex overflow-hidden">
          {searchResults && !viewingSessionId ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              <SearchResults
                results={searchResults}
                onOpenSession={(sid) => void handleOpenSessionFromSearch(sid)}
              />
            </div>
          ) : viewingSessionId ? (
            <>
              {/* Session event stream column */}
              <div className="flex flex-col overflow-hidden" style={{ width: investigatingEventId ? '50%' : '100%' }}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d] bg-[#161b22] shrink-0">
                  <div className="min-w-0 flex-1 mr-2">
                    <h3 className="text-sm font-medium text-[#e6edf3] truncate">
                      {bookmarks.find((b) => b.sessionId === viewingSessionId)?.name
                        ?? recordedSessions.find((s) => s.sessionId === viewingSessionId)?.sessionName
                        ?? 'Session History'}
                    </h3>
                    {/* Layman's Terms for historical session */}
                    <SessionLaymansTerms
                      summary={historicalSessionSummary}
                      summaryHistory={historicalSummaryHistory}
                      summaryError={historicalSummaryError}
                      isSummarizing={isSummarizingHistorical}
                      onGenerate={() => void handleGenerateHistoricalSummary(viewingSessionId)}
                      onClearError={() => setHistoricalSummaryError(null)}
                      className="max-w-full"
                      tooltipUp={false}
                      tooltipAlign="left"
                    />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {!bookmarkedSessionIds.has(viewingSessionId) && (
                      <button
                        onClick={() => void handleQuickBookmark(viewingSessionId)}
                        className="flex items-center gap-1 text-[#8b949e] hover:text-[#d29922] transition-colors text-xs"
                        title="Bookmark this session"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                        </svg>
                        Bookmark
                      </button>
                    )}
                    <button
                      onClick={() => setHistoricalFlowchartOpen(!historicalFlowchartOpen)}
                      className={`flex items-center gap-1 transition-colors text-xs ${
                        historicalFlowchartOpen
                          ? 'text-[#58a6ff]'
                          : 'text-[#8b949e] hover:text-[#e6edf3]'
                      }`}
                      title="Flowchart View"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M1 2.5A1.5 1.5 0 012.5 1h2A1.5 1.5 0 016 2.5v1A1.5 1.5 0 014.5 5h-2A1.5 1.5 0 011 3.5v-1zm0 5A1.5 1.5 0 012.5 6h2A1.5 1.5 0 016 7.5v1A1.5 1.5 0 014.5 10h-2A1.5 1.5 0 011 8.5v-1zm9-5A1.5 1.5 0 0111.5 1h2A1.5 1.5 0 0115 2.5v1A1.5 1.5 0 0113.5 5h-2A1.5 1.5 0 0110 3.5v-1zm0 5A1.5 1.5 0 0111.5 6h2A1.5 1.5 0 0115 7.5v1A1.5 1.5 0 0113.5 10h-2A1.5 1.5 0 0110 8.5v-1zM6 3h4M6 8h4" />
                        <path d="M6 3h4" stroke="currentColor" strokeWidth="1" fill="none" />
                        <path d="M6 8h4" stroke="currentColor" strokeWidth="1" fill="none" />
                      </svg>
                      Flowchart
                    </button>
                    <button
                      onClick={() => {
                        void (async () => {
                          try {
                            const res = await fetch(`/api/sessions/${encodeURIComponent(viewingSessionId)}/access-log`);
                            if (res.ok) {
                              const data = await res.json();
                              const store = useSessionStore.getState();
                              store.setAccessLogData(data);
                              store.setAccessLogOpen(true);
                            }
                          } catch { /* non-fatal */ }
                        })();
                      }}
                      className="flex items-center gap-1 text-[#8b949e] hover:text-[#e6edf3] transition-colors text-xs"
                      title="Access Log"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                      </svg>
                      Access Log
                    </button>
                    <button
                      onClick={() => setDeleteConfirmSessionId(viewingSessionId)}
                      className="flex items-center gap-1 text-[#8b949e] hover:text-[#f85149] transition-colors text-xs"
                      title="Delete session from history"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      Delete
                    </button>
                    <button
                      onClick={() => {
                        document.body.classList.add('layman-print-historical');
                        const cleanup = () => {
                          document.body.classList.remove('layman-print-historical');
                          window.removeEventListener('afterprint', cleanup);
                        };
                        window.addEventListener('afterprint', cleanup);
                        window.print();
                      }}
                      className="flex items-center gap-1 text-[#8b949e] hover:text-[#e6edf3] transition-colors text-xs"
                      title="Export to PDF"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                      </svg>
                      Export
                    </button>
                    <button
                      onClick={handleCloseSession}
                      className="text-[#8b949e] hover:text-[#e6edf3] transition-colors text-lg leading-none"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div data-print-hide>
                  <EventTypeFilterBar filters={eventTypeFilters} onChange={setEventTypeFilters} />
                </div>
                <div className="flex-1 overflow-hidden">
                  {historicalFlowchartOpen ? (
                    <div className="flex flex-col h-full">
                      <div data-print-hide className="flex items-center gap-1 px-3 py-1.5 bg-[#161b22] border-b border-[#30363d] shrink-0">
                        <button
                          onClick={() => setHistoricalViewMode('graph')}
                          className={`text-[10px] font-mono px-2.5 py-1 rounded transition-colors ${
                            historicalViewMode === 'graph'
                              ? 'bg-[#58a6ff]/15 text-[#58a6ff]'
                              : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
                          }`}
                        >
                          Graph
                        </button>
                        <button
                          onClick={() => setHistoricalViewMode('timeline')}
                          className={`text-[10px] font-mono px-2.5 py-1 rounded transition-colors ${
                            historicalViewMode === 'timeline'
                              ? 'bg-[#58a6ff]/15 text-[#58a6ff]'
                              : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
                          }`}
                        >
                          Timeline
                        </button>
                      </div>
                      <div className="flex-1 min-h-0">
                        <Suspense fallback={<div className="flex items-center justify-center h-full text-[#484f58] text-xs">Loading...</div>}>
                          {historicalViewMode === 'graph' ? (
                            <FlowchartView
                              events={filteredHistoricalEvents}
                              selectedEventId={investigatingEventId}
                              onSelectEvent={(id) => setInvestigatingEventId(investigatingEventId === id ? null : id)}
                            />
                          ) : (
                            <TimelineView
                              events={filteredHistoricalEvents}
                              selectedEventId={investigatingEventId}
                              onSelectEvent={(id) => setInvestigatingEventId(investigatingEventId === id ? null : id)}
                            />
                          )}
                        </Suspense>
                      </div>
                    </div>
                  ) : (
                    <HistoricalEventStream
                      events={filteredHistoricalEvents}
                      qaEntries={qaEntries}
                      selectedEventId={investigatingEventId}
                      onSelectEvent={(id) => setInvestigatingEventId(investigatingEventId === id ? null : id)}
                      onSend={onSend}
                    />
                  )}
                </div>
              </div>

              {/* Investigation panel column */}
              {investigatingEventId && (
                <div className="flex-1 border-l border-[#30363d] overflow-hidden">
                  <InvestigationPanel
                    onSend={onSend}
                    eventId={investigatingEventId}
                    onClose={() => setInvestigatingEventId(null)}
                  />
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center h-full gap-2 text-center p-8">
              <span className="text-4xl opacity-20"><svg width="36" height="36" viewBox="0 0 16 16" fill="currentColor" opacity="0.2"><path d="M1.5 3.25a.75.75 0 0 1 .75-.75h11.5a.75.75 0 0 1 0 1.5H2.25a.75.75 0 0 1-.75-.75Zm0 4.75A.75.75 0 0 1 2.25 7.25h11.5a.75.75 0 0 1 0 1.5H2.25A.75.75 0 0 1 1.5 8Zm0 4.75a.75.75 0 0 1 .75-.75h11.5a.75.75 0 0 1 0 1.5H2.25a.75.75 0 0 1-.75-.75Z"/></svg></span>
              <p className="text-sm text-[#484f58]">Select a bookmark or history entry to view its session</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
