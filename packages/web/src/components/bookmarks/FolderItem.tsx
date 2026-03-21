import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { BookmarkFolder, Bookmark } from '../../lib/types.js';
import { BookmarkItem } from './BookmarkItem.js';

interface FolderItemProps {
  folder: BookmarkFolder;
  bookmarks: Bookmark[];
  allFolders: BookmarkFolder[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onRenameBookmark: (id: string, name: string) => void;
  onMoveBookmark: (id: string, folderId: string | null) => void;
  onDeleteBookmark: (id: string) => void;
}

export function FolderItem({
  folder,
  bookmarks,
  allFolders,
  selectedSessionId,
  onSelectSession,
  onRenameFolder,
  onDeleteFolder,
  onRenameBookmark,
  onMoveBookmark,
  onDeleteBookmark,
}: FolderItemProps) {
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(folder.name);
  const [showMenu, setShowMenu] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

  const commitRename = useCallback(() => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== folder.name) {
      onRenameFolder(folder.id, trimmed);
    } else {
      setEditName(folder.name);
    }
    setEditing(false);
  }, [editName, folder.id, folder.name, onRenameFolder]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') {
      setEditName(folder.name);
      setEditing(false);
    }
  }, [commitRename, folder.name]);

  return (
    <div>
      <div className="group flex items-center gap-1.5 px-2 py-1.5 hover:bg-[#21262d] rounded-md mx-1 cursor-pointer transition-colors">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[#484f58] text-xs shrink-0 w-3 text-center"
        >
          {expanded ? '▾' : '▸'}
        </button>

        <span className="text-[#484f58] text-xs shrink-0">📁</span>

        {editing ? (
          <input
            ref={inputRef}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleKeyDown}
            className="flex-1 text-xs bg-[#0d1117] border border-[#58a6ff] rounded px-1 py-0.5 text-[#e6edf3] focus:outline-none min-w-0"
          />
        ) : (
          <span
            className="flex-1 text-xs text-[#8b949e] font-medium truncate"
            onClick={() => setExpanded((v) => !v)}
            onDoubleClick={() => setEditing(true)}
          >
            {folder.name}
          </span>
        )}

        <span className="text-[10px] text-[#484f58]">{bookmarks.length}</span>

        {!editing && (
          <div className="relative shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); setShowMenu((v) => !v); }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[#484f58] hover:text-[#e6edf3] transition-colors text-xs"
              title="More options"
            >
              ···
            </button>
            {showMenu && (
              <div
                ref={menuRef}
                className="absolute right-0 top-full mt-1 z-50 w-36 bg-[#161b22] border border-[#30363d] rounded-md shadow-lg py-1"
              >
                <button
                  onClick={() => { setEditing(true); setShowMenu(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-[#e6edf3] hover:bg-[#21262d] transition-colors"
                >
                  Rename
                </button>
                <div className="border-t border-[#30363d] my-1" />
                <button
                  onClick={() => { onDeleteFolder(folder.id); setShowMenu(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-[#f85149] hover:bg-[#21262d] transition-colors"
                >
                  Delete folder
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {expanded && bookmarks.length > 0 && (
        <div className="pl-4">
          {bookmarks.map((b) => (
            <BookmarkItem
              key={b.id}
              bookmark={b}
              folders={allFolders}
              isSelected={selectedSessionId === b.sessionId}
              onSelect={onSelectSession}
              onRename={onRenameBookmark}
              onMove={onMoveBookmark}
              onDelete={onDeleteBookmark}
            />
          ))}
        </div>
      )}

      {expanded && bookmarks.length === 0 && (
        <div className="pl-8 py-1">
          <span className="text-[10px] text-[#484f58] italic">Empty folder</span>
        </div>
      )}
    </div>
  );
}
