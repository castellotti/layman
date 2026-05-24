import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { Highlight, HighlightFolder, TimelineEvent } from '../../lib/types.js';
import { HighlightItem } from './HighlightItem.js';
import { HighlightFolderItem } from './HighlightFolderItem.js';
import { getEffectiveAgentContent } from '../../lib/reasoning.js';

const REMARK_PLUGINS = [remarkGfm];

const MARKDOWN_PROSE = `text-[10px] text-[#e6edf3] leading-relaxed prose prose-invert prose-xs max-w-none
  [&_p]:my-1 [&_p]:leading-relaxed
  [&_strong]:text-[#e6edf3] [&_strong]:font-semibold
  [&_em]:text-[#8b949e]
  [&_code]:text-[#79c0ff] [&_code]:bg-[#0d1117] [&_code]:px-1 [&_code]:rounded [&_code]:text-[10px]
  [&_pre]:bg-[#0d1117] [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto
  [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1
  [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:my-1
  [&_li]:my-0.5
  [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-[10px]
  [&_blockquote]:border-l-2 [&_blockquote]:border-[#30363d] [&_blockquote]:pl-2 [&_blockquote]:text-[#8b949e]`.replace(/\s+/g, ' ').trim();

interface HighlightEventPair {
  promptEvent: TimelineEvent | null;
  responseEvent: TimelineEvent | null;
}

function PromptEventBlock({ event }: { event: TimelineEvent }) {
  const { response } = getEffectiveAgentContent(event);
  const text = response.trim() || event.data.prompt || '';
  return (
    <div className="rounded-md border border-[#30363d] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1 bg-[#161b22] border-b border-[#30363d]">
        <span className="text-[10px] text-[#484f58] font-mono uppercase">Prompt</span>
        <span className="text-[10px] text-[#484f58]">{new Date(event.timestamp).toLocaleTimeString()}</span>
      </div>
      <div className="p-3 border-l-2 border-[#58a6ff]">
        {text ? (
          <div className={MARKDOWN_PROSE}><ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown></div>
        ) : (
          <span className="text-[10px] text-[#484f58] italic">No content</span>
        )}
      </div>
    </div>
  );
}

function ResponseEventBlock({ event }: { event: TimelineEvent }) {
  const { response } = getEffectiveAgentContent(event);
  const text = response.trim();
  return (
    <div className="rounded-md border border-[#30363d] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1 bg-[#161b22] border-b border-[#30363d]">
        <span className="text-[10px] text-[#484f58] font-mono uppercase">Response</span>
        <span className="text-[10px] text-[#484f58]">{new Date(event.timestamp).toLocaleTimeString()}</span>
      </div>
      <div className="p-3 border-l-2 border-[#3fb950]/50">
        {text ? (
          <div className={MARKDOWN_PROSE}><ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown></div>
        ) : (
          <span className="text-[10px] text-[#484f58] italic">No content</span>
        )}
      </div>
    </div>
  );
}

export function HighlightsPanel() {
  const {
    highlightFolders,
    highlights,
    navigateFromPromptsToSession,
  } = useSessionStore();

  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(null);
  const [eventPair, setEventPair] = useState<HighlightEventPair>({ promptEvent: null, responseEvent: null });
  const [loadingPair, setLoadingPair] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selectedHighlight = highlights.find((h) => h.id === selectedHighlightId) ?? null;

  const sortedFolders = [...highlightFolders].sort((a, b) => a.sortOrder - b.sortOrder);

  const folderHighlights = (folderId: string) =>
    highlights.filter((h) => h.folderId === folderId).sort((a, b) => a.sortOrder - b.sortOrder);

  const unfiledHighlights = highlights
    .filter((h) => h.folderId === null)
    .sort((a, b) => a.createdAt - b.createdAt);

  const allHighlightsSorted = [
    ...sortedFolders.flatMap((f) => folderHighlights(f.id)),
    ...unfiledHighlights,
  ];

  const filteredHighlights = searchQuery.trim()
    ? allHighlightsSorted.filter((h) => h.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : null;

  useEffect(() => {
    if (!selectedHighlightId) {
      setEventPair({ promptEvent: null, responseEvent: null });
      return;
    }
    setLoadingPair(true);
    void fetch(`/api/highlights/${selectedHighlightId}/events`)
      .then((r) => r.json())
      .then((d: { promptEvent?: TimelineEvent; responseEvent?: TimelineEvent }) => {
        setEventPair({ promptEvent: d.promptEvent ?? null, responseEvent: d.responseEvent ?? null });
      })
      .catch(() => {
        setEventPair({ promptEvent: null, responseEvent: null });
      })
      .finally(() => {
        setLoadingPair(false);
      });
  }, [selectedHighlightId]);

  const handleSelectHighlight = useCallback((h: Highlight) => {
    setSelectedHighlightId(h.id);
  }, []);

  const handleRenameHighlight = useCallback(async (id: string, name: string) => {
    await fetch(`/api/highlights/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => {});
  }, []);

  const handleMoveHighlight = useCallback(async (id: string, folderId: string | null) => {
    await fetch(`/api/highlights/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId }),
    }).catch(() => {});
  }, []);

  const handleDeleteHighlight = useCallback(async (id: string) => {
    await fetch(`/api/highlights/${id}`, { method: 'DELETE' }).catch(() => {});
    if (selectedHighlightId === id) {
      setSelectedHighlightId(null);
    }
  }, [selectedHighlightId]);

  const handleRenameFolder = useCallback(async (id: string, name: string) => {
    await fetch(`/api/highlights/folders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => {});
  }, []);

  const handleDeleteFolder = useCallback(async (id: string) => {
    await fetch(`/api/highlights/folders/${id}`, { method: 'DELETE' }).catch(() => {});
  }, []);

  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    await fetch('/api/highlights/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => {});
    setNewFolderName('');
    setShowNewFolder(false);
  }, [newFolderName]);

  const handleViewInSession = useCallback(() => {
    if (!selectedHighlight) return;
    navigateFromPromptsToSession(selectedHighlight.sessionId, selectedHighlight.promptEventId);
  }, [selectedHighlight, navigateFromPromptsToSession]);

  const hasContent = highlights.length > 0;

  return (
    <div className="flex flex-col h-full bg-[#0d1117]">
      {/* Search bar */}
      <div className="px-4 py-2 border-b border-[#30363d] bg-[#161b22] shrink-0">
        <input
          ref={searchInputRef}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search highlights..."
          className="w-full px-3 py-1.5 text-xs bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#bc8cff]"
        />
      </div>

      {/* Main content: sidebar + right panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: highlights tree */}
        <div className="w-72 shrink-0 bg-[#161b22] border-r border-[#30363d] flex flex-col overflow-hidden">

          {/* Toolbar */}
          <div className="flex items-center gap-1 px-2 py-2 border-b border-[#30363d]">
            <button
              onClick={() => setShowNewFolder(true)}
              title="New folder"
              className="px-2 py-1 text-xs rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d] transition-colors"
            >
              📁+ New folder
            </button>
          </div>

          {/* New folder form */}
          {showNewFolder && (
            <div className="px-3 py-2 border-b border-[#30363d] flex gap-2">
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateFolder();
                  if (e.key === 'Escape') { setShowNewFolder(false); setNewFolderName(''); }
                }}
                placeholder="Folder name"
                className="flex-1 px-2 py-1 text-xs bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#bc8cff] min-w-0"
              />
              <button onClick={() => void handleCreateFolder()} className="text-xs text-[#3fb950] hover:text-[#56d364] transition-colors">✓</button>
              <button onClick={() => { setShowNewFolder(false); setNewFolderName(''); }} className="text-xs text-[#484f58] hover:text-[#8b949e] transition-colors">✕</button>
            </div>
          )}

          {/* Highlights tree or empty state */}
          <div className="flex-1 overflow-y-auto py-2">
            {!hasContent ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-center py-8">
                <span className="text-2xl opacity-30">✦</span>
                <p className="text-xs text-[#8b949e]">No highlights yet.</p>
                <p className="text-[10px] text-[#484f58] leading-relaxed">
                  Click <strong className="text-[#8b949e]">Highlight</strong> next to a user prompt or agent response in the Logs view to save a prompt–response pair here.
                </p>
              </div>
            ) : filteredHighlights !== null ? (
              /* Search results — flat list */
              filteredHighlights.length === 0 ? (
                <p className="px-4 py-3 text-[11px] text-[#484f58] italic">No highlights match "{searchQuery}"</p>
              ) : (
                filteredHighlights.map((h) => (
                  <HighlightItem
                    key={h.id}
                    highlight={h}
                    folders={sortedFolders}
                    isSelected={selectedHighlightId === h.id}
                    onSelect={handleSelectHighlight}
                    onRename={(id, name) => void handleRenameHighlight(id, name)}
                    onMove={(id, fid) => void handleMoveHighlight(id, fid)}
                    onDelete={(id) => void handleDeleteHighlight(id)}
                  />
                ))
              )
            ) : (
              /* Normal tree view */
              <>
                {sortedFolders.map((folder) => (
                  <HighlightFolderItem
                    key={folder.id}
                    folder={folder}
                    highlights={folderHighlights(folder.id)}
                    allFolders={sortedFolders}
                    selectedHighlightId={selectedHighlightId}
                    onSelectHighlight={handleSelectHighlight}
                    onRenameFolder={(id, name) => void handleRenameFolder(id, name)}
                    onDeleteFolder={(id) => void handleDeleteFolder(id)}
                    onRenameHighlight={(id, name) => void handleRenameHighlight(id, name)}
                    onMoveHighlight={(id, fid) => void handleMoveHighlight(id, fid)}
                    onDeleteHighlight={(id) => void handleDeleteHighlight(id)}
                  />
                ))}

                {unfiledHighlights.length > 0 && (
                  <div className="mt-1">
                    {sortedFolders.length > 0 && (
                      <div className="px-3 py-1">
                        <span className="text-[10px] text-[#484f58] uppercase tracking-wider font-medium">Unfiled</span>
                      </div>
                    )}
                    {unfiledHighlights.map((h) => (
                      <HighlightItem
                        key={h.id}
                        highlight={h}
                        folders={sortedFolders}
                        isSelected={selectedHighlightId === h.id}
                        onSelect={handleSelectHighlight}
                        onRename={(id, name) => void handleRenameHighlight(id, name)}
                        onMove={(id, fid) => void handleMoveHighlight(id, fid)}
                        onDelete={(id) => void handleDeleteHighlight(id)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right: highlight detail view */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!selectedHighlight ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center p-8">
              <span className="text-3xl opacity-20">✦</span>
              <p className="text-sm text-[#8b949e]">Select a highlight to view</p>
              <p className="text-[11px] text-[#484f58] max-w-xs leading-relaxed">
                Highlights capture a prompt–response pair from any session for easy reference.
              </p>
            </div>
          ) : (
            <div className="flex flex-col h-full overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d] bg-[#161b22] shrink-0">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-medium text-[#e6edf3] truncate">{selectedHighlight.name}</h3>
                  <p className="text-[10px] text-[#484f58] mt-0.5">
                    {new Date(selectedHighlight.createdAt).toLocaleDateString(undefined, {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </p>
                </div>
                <button
                  onClick={handleViewInSession}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-[#30363d] text-[#8b949e] hover:text-[#bc8cff] hover:border-[#bc8cff]/30 transition-colors shrink-0 ml-3"
                  title="View full session with this highlight"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8Zm7.75-4.25a.75.75 0 0 0-1.5 0V8c0 .414.336.75.75.75h3.25a.75.75 0 0 0 0-1.5h-2.5V3.75Z"/>
                  </svg>
                  View in Session
                </button>
              </div>

              {/* Prompt + Response pair */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {loadingPair ? (
                  <div className="flex items-center justify-center h-full">
                    <p className="text-xs text-[#484f58]">Loading...</p>
                  </div>
                ) : (
                  <>
                    {eventPair.promptEvent ? (
                      <PromptEventBlock event={eventPair.promptEvent} />
                    ) : (
                      <div className="rounded-md border border-[#30363d] p-3">
                        <p className="text-[10px] text-[#484f58] italic">Prompt event not found (may have been purged)</p>
                      </div>
                    )}
                    {eventPair.responseEvent ? (
                      <ResponseEventBlock event={eventPair.responseEvent} />
                    ) : (
                      <div className="rounded-md border border-[#30363d] p-3">
                        <p className="text-[10px] text-[#484f58] italic">Response event not found (may have been purged)</p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
