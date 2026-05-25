import React from 'react';
import type { Highlight, HighlightFolder } from '../../lib/types.js';
import { useInlineEdit } from '../../hooks/useInlineEdit.js';

interface HighlightItemProps {
  highlight: Highlight;
  folders: HighlightFolder[];
  isSelected: boolean;
  onSelect: (highlight: Highlight) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, folderId: string | null) => void;
  onDelete: (id: string) => void;
}

export function HighlightItem({ highlight, folders, isSelected, onSelect, onRename, onMove, onDelete }: HighlightItemProps) {
  const { editing, setEditing, editName, setEditName, showMenu, setShowMenu, inputRef, menuRef, commitRename, handleKeyDown } =
    useInlineEdit(highlight.name, (name) => onRename(highlight.id, name));

  const otherFolders = folders.filter((f) => f.id !== highlight.folderId);

  return (
    <div
      className={`group flex items-center gap-1.5 px-3 py-1.5 cursor-pointer rounded-md mx-1 transition-colors ${
        isSelected ? 'bg-[#6e40c9]/20 border border-[#bc8cff]/30' : 'hover:bg-[#21262d]'
      }`}
      onClick={() => !editing && onSelect(highlight)}
    >
      <span className="text-[#bc8cff] text-xs shrink-0">✦</span>

      {editing ? (
        <input
          ref={inputRef}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 text-xs bg-[#0d1117] border border-[#bc8cff] rounded px-1 py-0.5 text-[#e6edf3] focus:outline-none min-w-0"
        />
      ) : (
        <span className="flex-1 text-xs text-[#e6edf3] truncate" onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}>
          {highlight.name}
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
              {highlight.folderId !== null && (
                <button
                  onClick={() => { onMove(highlight.id, null); setShowMenu(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-[#e6edf3] hover:bg-[#21262d] transition-colors"
                >
                  Move to Unfiled
                </button>
              )}
              {otherFolders.map((f) => (
                <button
                  key={f.id}
                  onClick={() => { onMove(highlight.id, f.id); setShowMenu(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-[#e6edf3] hover:bg-[#21262d] transition-colors truncate"
                >
                  Move to "{f.name}"
                </button>
              ))}
              <div className="border-t border-[#30363d] my-1" />
              <button
                onClick={() => { onDelete(highlight.id); setShowMenu(false); }}
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
