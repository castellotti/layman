import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { Bookmark, BookmarkFolder } from '../../lib/types.js';

interface BookmarkItemProps {
  bookmark: Bookmark;
  folders: BookmarkFolder[];
  isSelected: boolean;
  onSelect: (sessionId: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, folderId: string | null) => void;
  onDelete: (id: string) => void;
}

export function BookmarkItem({ bookmark, folders, isSelected, onSelect, onRename, onMove, onDelete }: BookmarkItemProps) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(bookmark.name);
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
    if (trimmed && trimmed !== bookmark.name) {
      onRename(bookmark.id, trimmed);
    } else {
      setEditName(bookmark.name);
    }
    setEditing(false);
  }, [editName, bookmark.id, bookmark.name, onRename]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') {
      setEditName(bookmark.name);
      setEditing(false);
    }
  }, [commitRename, bookmark.name]);

  const otherFolders = folders.filter((f) => f.id !== bookmark.folderId);

  return (
    <div
      className={`group flex items-center gap-1.5 px-3 py-1.5 cursor-pointer rounded-md mx-1 transition-colors ${
        isSelected ? 'bg-[#1f6feb]/20 border border-[#388bfd]/30' : 'hover:bg-[#21262d]'
      }`}
      onClick={() => !editing && onSelect(bookmark.sessionId)}
    >
      <span className="text-[#484f58] text-xs shrink-0">🔖</span>

      {editing ? (
        <input
          ref={inputRef}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 text-xs bg-[#0d1117] border border-[#58a6ff] rounded px-1 py-0.5 text-[#e6edf3] focus:outline-none min-w-0"
        />
      ) : (
        <span className="flex-1 text-xs text-[#e6edf3] truncate" onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}>
          {bookmark.name}
        </span>
      )}

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
              className="absolute right-0 top-full mt-1 z-50 w-44 bg-[#161b22] border border-[#30363d] rounded-md shadow-lg py-1"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => { setEditing(true); setShowMenu(false); }}
                className="w-full text-left px-3 py-1.5 text-xs text-[#e6edf3] hover:bg-[#21262d] transition-colors"
              >
                Rename
              </button>
              {bookmark.folderId !== null && (
                <button
                  onClick={() => { onMove(bookmark.id, null); setShowMenu(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-[#e6edf3] hover:bg-[#21262d] transition-colors"
                >
                  Move to Unfiled
                </button>
              )}
              {otherFolders.map((f) => (
                <button
                  key={f.id}
                  onClick={() => { onMove(bookmark.id, f.id); setShowMenu(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-[#e6edf3] hover:bg-[#21262d] transition-colors truncate"
                >
                  Move to "{f.name}"
                </button>
              ))}
              <div className="border-t border-[#30363d] my-1" />
              <button
                onClick={() => { onDelete(bookmark.id); setShowMenu(false); }}
                className="w-full text-left px-3 py-1.5 text-xs text-[#f85149] hover:bg-[#21262d] transition-colors"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
