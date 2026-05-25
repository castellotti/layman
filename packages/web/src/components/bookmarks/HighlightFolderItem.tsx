import React, { useState } from 'react';
import type { HighlightFolder, Highlight } from '../../lib/types.js';
import { HighlightItem } from './HighlightItem.js';
import { useInlineEdit } from '../../hooks/useInlineEdit.js';

interface HighlightFolderItemProps {
  folder: HighlightFolder;
  highlights: Highlight[];
  allFolders: HighlightFolder[];
  selectedHighlightId: string | null;
  onSelectHighlight: (highlight: Highlight) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onRenameHighlight: (id: string, name: string) => void;
  onMoveHighlight: (id: string, folderId: string | null) => void;
  onDeleteHighlight: (id: string) => void;
}

export function HighlightFolderItem({
  folder,
  highlights,
  allFolders,
  selectedHighlightId,
  onSelectHighlight,
  onRenameFolder,
  onDeleteFolder,
  onRenameHighlight,
  onMoveHighlight,
  onDeleteHighlight,
}: HighlightFolderItemProps) {
  const [expanded, setExpanded] = useState(true);
  const { editing, setEditing, editName, setEditName, showMenu, setShowMenu, inputRef, menuRef, commitRename, handleKeyDown } =
    useInlineEdit(folder.name, (name) => onRenameFolder(folder.id, name));

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
            className="flex-1 text-xs bg-[#0d1117] border border-[#bc8cff] rounded px-1 py-0.5 text-[#e6edf3] focus:outline-none min-w-0"
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

        <span className="text-[10px] text-[#484f58]">{highlights.length}</span>

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

      {expanded && highlights.length > 0 && (
        <div className="pl-4">
          {highlights.map((h) => (
            <HighlightItem
              key={h.id}
              highlight={h}
              folders={allFolders}
              isSelected={selectedHighlightId === h.id}
              onSelect={onSelectHighlight}
              onRename={onRenameHighlight}
              onMove={onMoveHighlight}
              onDelete={onDeleteHighlight}
            />
          ))}
        </div>
      )}

      {expanded && highlights.length === 0 && (
        <div className="pl-8 py-1">
          <span className="text-[10px] text-[#484f58] italic">Empty folder</span>
        </div>
      )}
    </div>
  );
}
