import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import type { RecordedSession, QAEntry } from '../../lib/types.js';
import { BookmarkEmptyState } from './BookmarkEmptyState.js';
import { FolderItem } from './FolderItem.js';
import { BookmarkItem } from './BookmarkItem.js';
import { HistoricalEventStream } from './HistoricalEventStream.js';

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
  } = useSessionStore();

  const [recordedSessions, setRecordedSessions] = useState<RecordedSession[]>([]);
  const [qaEntries, setQaEntries] = useState<QAEntry[]>([]);
  const [selectedHistoricalEventId, setSelectedHistoricalEventId] = useState<string | null>(null);
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

  const recordingEnabled = config?.sessionRecording ?? false;

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

  // Load recorded sessions when panel opens
  useEffect(() => {
    if (!bookmarksOpen) return;
    refreshRecordedSessions();
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
    setSelectedHistoricalEventId(null);
    setViewingSession(sessionId);
    try {
      const [evRes, qaRes] = await Promise.all([
        fetch(`/api/bookmarks/sessions/${sessionId}/events`),
        fetch(`/api/bookmarks/sessions/${sessionId}/qa`),
      ]);
      const evData = await evRes.json() as { events?: Parameters<typeof setHistoricalEvents>[0] };
      const qaData = await qaRes.json() as { qa?: QAEntry[] };
      setHistoricalEvents(evData.events ?? []);
      setQaEntries(qaData.qa ?? []);
    } catch {
      setHistoricalEvents([]);
      setQaEntries([]);
    }
  }, [viewingSessionId, setViewingSession, setHistoricalEvents]);

  const handleCloseSession = useCallback(() => {
    setViewingSession(null);
    setQaEntries([]);
    setSelectedHistoricalEventId(null);
  }, [setViewingSession]);

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

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Overlay */}
      <div className="fixed inset-0 bg-black/50" onClick={() => setBookmarksOpen(false)} />

      {/* Panel */}
      <div className="relative flex w-full max-w-5xl mx-auto my-0 h-full bg-[#0d1117] shadow-2xl">
        {/* Left: bookmark tree */}
        <div className="w-72 shrink-0 bg-[#161b22] border-r border-[#30363d] flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d]">
            <h2 className="text-sm font-semibold text-[#e6edf3]">Bookmarks</h2>
            <button
              onClick={() => setBookmarksOpen(false)}
              className="text-[#8b949e] hover:text-[#e6edf3] transition-colors text-lg leading-none"
            >
              ×
            </button>
          </div>

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
                    {getSessionLabel(s.cwd, s.sessionId)}
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
                    {getSessionLabel(s.cwd, s.sessionId)} · {new Date(s.lastSeen).toLocaleDateString()}
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
          <div className="flex-1 overflow-y-auto py-2">
            {!hasContent && !recordingEnabled ? (
              <BookmarkEmptyState recordingEnabled={false} onSend={onSend} />
            ) : !hasContent && recordingEnabled ? (
              <BookmarkEmptyState recordingEnabled={true} onSend={onSend} />
            ) : (
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
            )}
          </div>
        </div>

        {/* Right: historical event stream */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {viewingSessionId ? (
            <>
              <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d] bg-[#161b22] shrink-0">
                <div>
                  <h3 className="text-sm font-medium text-[#e6edf3]">
                    {bookmarks.find((b) => b.sessionId === viewingSessionId)?.name ?? 'Session History'}
                  </h3>
                  <p className="text-[10px] text-[#484f58]">
                    {recordedSessions.find((s) => s.sessionId === viewingSessionId)?.cwd ?? viewingSessionId}
                  </p>
                </div>
                <button
                  onClick={handleCloseSession}
                  className="text-[#8b949e] hover:text-[#e6edf3] transition-colors text-lg leading-none"
                >
                  ×
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                <HistoricalEventStream
                  events={historicalEvents}
                  qaEntries={qaEntries}
                  selectedEventId={selectedHistoricalEventId}
                  onSelectEvent={setSelectedHistoricalEventId}
                />
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center p-8">
              <span className="text-4xl opacity-20">🔖</span>
              <p className="text-sm text-[#484f58]">Select a bookmark to view its session history</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
