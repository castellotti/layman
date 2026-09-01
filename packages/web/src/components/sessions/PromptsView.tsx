import React, { useState, useCallback, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { Highlight, HighlightFolder, TimelineEvent } from '../../lib/types.js';
import { SearchInput, FilterChip, SECTION_LABEL_STYLE, CollapsibleFolderHeader, FolderSectionHeader, ConfirmDialog, CopyLinkButton } from '../primitives/index.js';
import { getEffectiveAgentContent } from '../../lib/reasoning.js';
import { isMarkdown, MARKDOWN_PROSE_COMPACT, REMARK_PLUGINS } from '../../lib/markdown.js';
import { sessionDisplayName } from '../../lib/session-state.js';
import { useDragReorder } from '../../hooks/useDragReorder.js';
import { useOptimisticOrder } from '../../hooks/useOptimisticOrder.js';
import { useFolderDrag, reorderIds, type FolderDragSource, type FolderDropTarget } from '../../hooks/useFolderDrag.js';
import { useFolderCrud } from '../../hooks/useFolderCrud.js';
import { useExpandedSections } from '../../hooks/useExpandedSections.js';
import { useInlineEdit } from '../../hooks/useInlineEdit.js';
import { SpeakButton } from '../tts/SpeakButton.js';

interface HighlightEventPair {
  promptEvent: TimelineEvent | null;
  responseEvent: TimelineEvent | null;
}

// ─── EventBlock ───────────────────────────────────────────────────────────────

function EventBlock({ event, kind }: { event: TimelineEvent; kind: 'prompt' | 'response' }) {
  const { response } = getEffectiveAgentContent(event);
  const text = kind === 'prompt' ? (response.trim() || event.data.prompt || '') : response.trim();
  const accent = kind === 'prompt' ? 'var(--info)' : 'var(--agent)';

  return (
    <div style={{ borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '4px 12px', background: 'var(--bg-raised)', borderBottom: '1px solid var(--border)',
      }}>
        <span style={{
          fontSize: 9.5, fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
          letterSpacing: '0.06em', color: 'var(--text-faint)',
        }}>
          {kind === 'prompt' ? 'Prompt' : 'Response'}
        </span>
        <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
      </div>
      <div style={{
        padding: 12,
        borderLeft: `2px solid ${accent}`,
        background: 'var(--bg-card)',
      }}>
        {text ? (
          <div className={MARKDOWN_PROSE_COMPACT}>
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>
          </div>
        ) : (
          <span style={{ fontSize: 10, color: 'var(--text-faint)', fontStyle: 'italic' }}>No content</span>
        )}
      </div>
    </div>
  );
}

// ─── SidebarHighlightRow ──────────────────────────────────────────────────────

interface SidebarHighlightRowProps {
  highlight: Highlight;
  isSelected: boolean;
  indent?: boolean;
  sessionLabel?: string;
  isDragOver?: boolean;
  onSelect: (h: Highlight) => void;
  onRename?: (name: string) => void;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDragEnd?: () => void;
}

function SidebarHighlightRow({
  highlight, isSelected, indent = false, sessionLabel, isDragOver = false,
  onSelect, onRename, onDragStart, onDragOver, onDragEnd,
}: SidebarHighlightRowProps) {
  const [hovered, setHovered] = useState(false);
  const date = new Date(highlight.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const draggable = !!onDragStart;
  const { editing, setEditing, editName, setEditName, commitRename, handleKeyDown, inputRef } =
    useInlineEdit(highlight.name, (next) => onRename?.(next));

  const startEditing = () => {
    setEditName(highlight.name);
    setEditing(true);
  };

  return (
    <div
      draggable={draggable && !editing}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart?.(); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDragOver?.(); }}
      onDragEnd={onDragEnd}
      style={{
        borderTop: isDragOver ? '2px solid var(--info)' : '2px solid transparent',
        transition: 'border-color 0.1s',
      }}
    >
    <button
      onClick={() => { if (!editing) onSelect(highlight); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 6,
        padding: indent ? '5px 12px 5px 24px' : '5px 12px',
        background: isSelected ? 'var(--bg-selected)' : hovered ? 'var(--bg-card)' : 'transparent',
        border: 'none', cursor: 'pointer', textAlign: 'left',
        borderLeft: isSelected ? '2px solid var(--accent)' : '2px solid transparent',
        transition: 'background 0.1s',
      }}
    >
      {draggable && (
        <span style={{
          fontSize: 11, color: 'var(--text-faint)', cursor: 'grab', flexShrink: 0,
          opacity: hovered ? 0.7 : 0.25, userSelect: 'none', lineHeight: 1,
        }}>
          ⠿
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input
            ref={inputRef}
            value={editName}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { e.stopPropagation(); handleKeyDown(e); }}
            style={{
              width: '100%', fontSize: 11, fontFamily: 'var(--font-ui)',
              background: 'var(--bg-card)', border: '1px solid var(--border-strong)',
              borderRadius: 3, color: 'var(--text)', padding: '1px 4px', outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        ) : (
          <div style={{
            fontSize: 11, fontWeight: 500, color: 'var(--text)', fontFamily: 'var(--font-ui)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {highlight.name}
          </div>
        )}
        <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
          {sessionLabel ? `${sessionLabel} · ${date}` : date}
        </div>
      </div>
      {!editing && onRename && (
        <span
          role="button"
          onClick={(e) => { e.stopPropagation(); startEditing(); }}
          title="Rename highlight"
          style={{
            fontSize: 10, color: 'var(--text-faint)', cursor: 'pointer', padding: '1px 3px',
            flexShrink: 0, opacity: hovered ? 1 : 0, transition: 'opacity 0.1s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}
        >
          ✎
        </span>
      )}
    </button>
    </div>
  );
}

// ─── SidebarFolder ────────────────────────────────────────────────────────────

interface SidebarFolderProps {
  folder: HighlightFolder;
  highlights: Highlight[];
  expanded: boolean;
  onToggle: () => void;
  selectedHighlightId: string | null;
  sessionLabelById: Map<string, string>;
  onSelect: (h: Highlight) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onRenameHighlight: (id: string, name: string) => void;
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
  folder, highlights, expanded, onToggle, selectedHighlightId, sessionLabelById, onSelect,
  onRename, onDelete, onRenameHighlight,
  draggedItemId, dragOverContainerId, dragOverItemId,
  onItemDragStart, onItemDragOverItem, onItemDragOverContainer, onItemDragEnd,
  isFolderDragOver, onFolderDragStart, onFolderDragOver, onFolderDragEnd,
}: SidebarFolderProps) {
  return (
    <div>
      <CollapsibleFolderHeader
        expanded={expanded}
        onToggle={onToggle}
        name={folder.name}
        count={highlights.length}
        onRename={onRename}
        onDelete={onDelete}
        draggable
        isDragOver={isFolderDragOver || (dragOverContainerId === folder.id && dragOverItemId === null)}
        onDragStart={onFolderDragStart}
        onDragOver={() => { onFolderDragOver(); onItemDragOverContainer(folder.id); }}
        onDragEnd={onFolderDragEnd}
      />
      {expanded && highlights.length === 0 && (
        <div
          onDragOver={(e) => { e.preventDefault(); onItemDragOverContainer(folder.id); }}
          style={{ padding: '4px 24px', fontSize: 10, color: 'var(--text-faint)', fontStyle: 'italic' }}
        >
          Drop highlights here
        </div>
      )}
      {expanded && highlights.map((h) => (
        <SidebarHighlightRow
          key={h.id}
          highlight={h}
          isSelected={selectedHighlightId === h.id}
          indent
          sessionLabel={sessionLabelById.get(h.sessionId)}
          isDragOver={draggedItemId !== h.id && dragOverContainerId === folder.id && dragOverItemId === h.id}
          onSelect={onSelect}
          onRename={(name) => onRenameHighlight(h.id, name)}
          onDragStart={() => onItemDragStart({ id: h.id, containerId: folder.id, bookmarked: true })}
          onDragOver={() => onItemDragOverItem(folder.id, h.id)}
          onDragEnd={onItemDragEnd}
        />
      ))}
    </div>
  );
}

// ─── PromptsView ──────────────────────────────────────────────────────────────

export function PromptsView() {
  const { highlightFolders, highlights, sessions, navigateFromPromptsToSession, setSelectedEvent, setInvestigationOpen } = useSessionStore();

  // Selection lives in the store, not locally, because it is addressable: /h/<id>
  // hydrates it and the outbound URL sync reads it back (see useLaymanRoute).
  const selectedHighlightId = useSessionStore((s) => s.selectedHighlightId);
  const setSelectedHighlightId = useSessionStore((s) => s.setSelectedHighlight);
  const [eventPair, setEventPair] = useState<HighlightEventPair>({ promptEvent: null, responseEvent: null });
  const [loadingPair, setLoadingPair] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteConfirmFolderId, setDeleteConfirmFolderId] = useState<string | null>(null);

  const sessionLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      map.set(s.sessionId, sessionDisplayName(s.sessionName, s.cwd, s.sessionId));
    }
    return map;
  }, [sessions]);

  const selectedHighlight = highlights.find((h) => h.id === selectedHighlightId) ?? null;

  const sortedFolders = useMemo(
    () => [...highlightFolders].sort((a, b) => a.sortOrder - b.sortOrder),
    [highlightFolders]
  );

  // Computed once per folder (not per render call site) since it's looked up from
  // both a `.some` check and a `.map` below.
  const folderHighlightsMap = useMemo(() => {
    const map = new Map<string, Highlight[]>();
    for (const folder of sortedFolders) {
      map.set(folder.id, highlights.filter((h) => h.folderId === folder.id).sort((a, b) => a.sortOrder - b.sortOrder));
    }
    return map;
  }, [sortedFolders, highlights]);

  const unfiledHighlights = useMemo(
    () => highlights.filter((h) => h.folderId === null).sort((a, b) => b.createdAt - a.createdAt),
    [highlights]
  );

  const filteredHighlights = useMemo(
    () => searchQuery.trim()
      ? highlights.filter((h) => h.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : null,
    [searchQuery, highlights]
  );

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
      .catch(() => setEventPair({ promptEvent: null, responseEvent: null }))
      .finally(() => setLoadingPair(false));
  }, [selectedHighlightId]);

  const handleSelectHighlight = useCallback((h: Highlight) => setSelectedHighlightId(h.id), [setSelectedHighlightId]);

  const handleViewInSession = useCallback(() => {
    if (!selectedHighlight) return;
    navigateFromPromptsToSession(selectedHighlight.sessionId, selectedHighlight.promptEventId);
  }, [selectedHighlight, navigateFromPromptsToSession]);

  const handleInvestigate = useCallback(() => {
    if (!selectedHighlight) return;
    const investigateEventId = eventPair.responseEvent?.id ?? eventPair.promptEvent?.id ?? selectedHighlight.responseEventId;
    setSelectedEvent(investigateEventId);
    setInvestigationOpen(true);
    navigateFromPromptsToSession(selectedHighlight.sessionId, selectedHighlight.promptEventId);
  }, [selectedHighlight, eventPair, navigateFromPromptsToSession, setSelectedEvent, setInvestigationOpen]);

  // Collapsed by default; expanded folders are remembered across reloads.
  const { isExpanded, toggle: toggleExpanded } = useExpandedSections('layman.prompts.expandedFolders');

  const handleRenameHighlight = useCallback((id: string, name: string) => {
    void fetch(`/api/highlights/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => {});
  }, []);

  const handleMoveToFolder = useCallback((folderId: string | null) => {
    if (!selectedHighlight) return;
    void fetch(`/api/highlights/${selectedHighlight.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId }),
    }).catch(() => {});
  }, [selectedHighlight]);

  // Folder CRUD — same backend as Sessions' bookmark folders, previously unwired.
  const { handleCreateFolder, handleRenameFolder, handleDeleteFolder, persistFolderOrder } =
    useFolderCrud('/api/highlights/folders');
  const { items: orderedFolders, reorder: reorderFolders } = useOptimisticOrder(sortedFolders, (f) => f.id, persistFolderOrder);
  const {
    dragOverId: folderDragOverId,
    handleDragStart: handleFolderDragStart, handleDragOver: handleFolderDragOver, handleDragEnd: handleFolderDragEnd,
  } = useDragReorder(reorderFolders);

  // Cross-container item drag (highlights ↔ folders/History). Every draggable
  // row here is already a highlight (unlike Sessions, there's no "not yet
  // bookmarked" source list), so this only ever reorders or moves.
  const handleFolderDrop = useCallback((source: FolderDragSource, target: FolderDropTarget) => {
    const targetFolderId = target.containerId === 'unfiled' ? null : target.containerId;

    if (source.containerId === target.containerId) {
      const currentIds = target.containerId === 'unfiled'
        ? unfiledHighlights.map((h) => h.id)
        : (folderHighlightsMap.get(target.containerId) ?? []).map((h) => h.id);
      const newIds = reorderIds(currentIds, source.id, target.beforeId);
      void fetch('/api/highlights/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: targetFolderId, ids: newIds }),
      }).catch(() => {});
    } else {
      void fetch(`/api/highlights/${source.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: targetFolderId }),
      }).catch(() => {});
    }
  }, [unfiledHighlights, folderHighlightsMap]);

  const {
    draggedId: draggedItemId, dragOverContainerId, dragOverItemId,
    handleDragStart: handleItemDragStart, handleDragOverItem, handleDragOverContainer, handleDragEnd: handleItemDragEnd,
  } = useFolderDrag(handleFolderDrop);

  const sectionLabel = SECTION_LABEL_STYLE;

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg)' }}>
      {/* Delete folder confirmation */}
      {deleteConfirmFolderId && (
        <ConfirmDialog
          title="Delete folder?"
          body="Highlights inside this folder move to History — they aren't deleted."
          onCancel={() => setDeleteConfirmFolderId(null)}
          onConfirm={() => handleDeleteFolder(deleteConfirmFolderId, () => setDeleteConfirmFolderId(null))}
        />
      )}

      {/* Left sidebar */}
      <div style={{
        width: 280, flexShrink: 0,
        background: 'var(--bg-raised)', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Search */}
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search highlights…" />
        </div>

        {/* Highlights tree */}
        <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
          {highlights.length === 0 ? (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              height: '100%', gap: 12, padding: '32px 16px', textAlign: 'center',
            }}>
              <span style={{ fontSize: 24, opacity: 0.2 }}>✦</span>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>No highlights yet.</p>
              <p style={{ fontSize: 10, color: 'var(--text-faint)', margin: 0, lineHeight: 1.5 }}>
                Click <strong style={{ color: 'var(--text-muted)' }}>Highlight</strong> next to a user prompt or agent response in the Logs view.
              </p>
            </div>
          ) : filteredHighlights !== null ? (
            filteredHighlights.length === 0 ? (
              <p style={{ padding: '12px 16px', fontSize: 11, color: 'var(--text-faint)', fontStyle: 'italic' }}>
                No highlights match "{searchQuery}"
              </p>
            ) : (
              <>
                <div style={sectionLabel}>Results</div>
                {filteredHighlights.map((h) => (
                  <SidebarHighlightRow
                    key={h.id}
                    highlight={h}
                    isSelected={selectedHighlightId === h.id}
                    sessionLabel={sessionLabelById.get(h.sessionId)}
                    onSelect={handleSelectHighlight}
                    onRename={(name) => handleRenameHighlight(h.id, name)}
                  />
                ))}
              </>
            )
          ) : (
            <>
              <FolderSectionHeader label="Folders" onCreate={handleCreateFolder} />
              {orderedFolders.map((folder) => {
                const items = folderHighlightsMap.get(folder.id) ?? [];
                return (
                  <SidebarFolder
                    key={folder.id}
                    folder={folder}
                    highlights={items}
                    expanded={isExpanded(folder.id)}
                    onToggle={() => toggleExpanded(folder.id)}
                    selectedHighlightId={selectedHighlightId}
                    sessionLabelById={sessionLabelById}
                    onSelect={handleSelectHighlight}
                    onRename={(name) => handleRenameFolder(folder.id, name)}
                    onDelete={() => setDeleteConfirmFolderId(folder.id)}
                    onRenameHighlight={handleRenameHighlight}
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
                History <span style={{ fontSize: 9, color: 'var(--text-faint)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>newest first</span>
              </div>
              {unfiledHighlights.length === 0 && (
                <div
                  onDragOver={(e) => { e.preventDefault(); handleDragOverContainer('unfiled'); }}
                  style={{ padding: '4px 12px', fontSize: 10, color: 'var(--text-faint)', fontStyle: 'italic' }}
                >
                  Drop highlights here
                </div>
              )}
              {unfiledHighlights.map((h) => (
                <SidebarHighlightRow
                  key={h.id}
                  highlight={h}
                  isSelected={selectedHighlightId === h.id}
                  sessionLabel={sessionLabelById.get(h.sessionId)}
                  isDragOver={draggedItemId !== h.id && dragOverContainerId === 'unfiled' && dragOverItemId === h.id}
                  onSelect={handleSelectHighlight}
                  onRename={(name) => handleRenameHighlight(h.id, name)}
                  onDragStart={() => handleItemDragStart({ id: h.id, containerId: 'unfiled', bookmarked: true })}
                  onDragOver={() => handleDragOverItem('unfiled', h.id)}
                  onDragEnd={handleItemDragEnd}
                />
              ))}
            </>
          )}
        </div>
      </div>

      {/* Right: highlight detail */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {!selectedHighlight ? (
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 12, padding: '0 32px', textAlign: 'center',
          }}>
            <span style={{ fontSize: 28, opacity: 0.15 }}>✦</span>
            <p style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 500, color: 'var(--text)', margin: 0 }}>
              Select a highlight
            </p>
            <p style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', margin: 0, maxWidth: 280, lineHeight: 1.5 }}>
              Highlights capture a prompt–response pair from any session for easy reference.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 16px', borderBottom: '1px solid var(--border)',
              background: 'var(--bg-raised)', flexShrink: 0,
            }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <h3 style={{
                  fontSize: 12, fontWeight: 600, color: 'var(--text)',
                  fontFamily: 'var(--font-ui)', margin: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {selectedHighlight.name}
                </h3>
                <p style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', margin: '2px 0 0' }}>
                  {new Date(selectedHighlight.createdAt).toLocaleDateString(undefined, {
                    month: 'short', day: 'numeric', year: 'numeric',
                  })}
                </p>
              </div>
              {eventPair.responseEvent && (
                <SpeakButton
                  id={eventPair.responseEvent.id}
                  text={getEffectiveAgentContent(eventPair.responseEvent).response}
                  title="Speak this highlight's response"
                  size={13}
                />
              )}
              <CopyLinkButton
                route={{ kind: 'highlight', highlightId: selectedHighlight.id }}
                title="Copy link to this highlight"
              />
              <button
                onClick={handleViewInSession}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px', borderRadius: 5, fontSize: 11,
                  fontFamily: 'var(--font-ui)', cursor: 'pointer',
                  background: 'none', border: '1px solid var(--border)',
                  color: 'var(--text-muted)',
                  transition: 'color 0.15s, border-color 0.15s',
                  flexShrink: 0, marginLeft: 12,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'var(--text)';
                  e.currentTarget.style.borderColor = 'var(--border-strong)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'var(--text-muted)';
                  e.currentTarget.style.borderColor = 'var(--border)';
                }}
                title="Open the full session with this highlight"
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8Zm7.75-4.25a.75.75 0 0 0-1.5 0V8c0 .414.336.75.75.75h3.25a.75.75 0 0 0 0-1.5h-2.5V3.75Z"/>
                </svg>
                Open session
              </button>
            </div>

            {/* Prompt + Response */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {loadingPair ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
                  <p style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-ui)' }}>Loading…</p>
                </div>
              ) : (
                <>
                  {eventPair.promptEvent ? (
                    <EventBlock event={eventPair.promptEvent} kind="prompt" />
                  ) : (
                    <div style={{ borderRadius: 8, border: '1px solid var(--border)', padding: 12 }}>
                      <p style={{ fontSize: 10, color: 'var(--text-faint)', fontStyle: 'italic', margin: 0 }}>
                        Prompt event not found (may have been purged)
                      </p>
                    </div>
                  )}
                  {eventPair.responseEvent ? (
                    <EventBlock event={eventPair.responseEvent} kind="response" />
                  ) : (
                    <div style={{ borderRadius: 8, border: '1px solid var(--border)', padding: 12 }}>
                      <p style={{ fontSize: 10, color: 'var(--text-faint)', fontStyle: 'italic', margin: 0 }}>
                        Response event not found (may have been purged)
                      </p>
                    </div>
                  )}

                  {/* Actions */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <span
                      role="button"
                      onClick={handleInvestigate}
                      style={{ fontSize: 10, color: 'var(--text-faint)', cursor: 'pointer' }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}
                    >
                      ⌕ investigate
                    </span>
                    {sortedFolders.length > 0 && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--text-faint)', cursor: 'pointer' }}>
                        ▸ move to folder
                        <select
                          value={selectedHighlight.folderId ?? ''}
                          onChange={(e) => handleMoveToFolder(e.target.value || null)}
                          style={{
                            fontSize: 10, fontFamily: 'var(--font-mono)', background: 'var(--bg-card)',
                            border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-muted)',
                            padding: '2px 4px', outline: 'none', cursor: 'pointer',
                          }}
                        >
                          <option value="">Unfiled</option>
                          {sortedFolders.map((f) => (
                            <option key={f.id} value={f.id}>{f.name}</option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
