import { useState, useEffect, useRef, useCallback } from 'react';
import type { KeyboardEvent } from 'react';

export function useInlineEdit(initialName: string, onCommit: (name: string) => void) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(initialName);
  const [showMenu, setShowMenu] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Guards against commitRename firing twice for one edit — Enter calls it
  // directly, which sets editing=false and unmounts the input; removing a
  // focused input triggers a native blur, which calls it again via onBlur.
  const committedRef = useRef(false);

  useEffect(() => {
    if (editing && inputRef.current) {
      committedRef.current = false;
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
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = editName.trim();
    if (trimmed && trimmed !== initialName) {
      onCommit(trimmed);
    }
    // Always reset — on success this clears the field for the next time
    // editing opens (relevant for callers like NewFolderRow whose
    // initialName is always '' and don't reset it themselves); on cancel
    // it discards the abandoned edit.
    setEditName(initialName);
    setEditing(false);
  }, [editName, initialName, onCommit]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') {
      // Mark this edit as finalized before unmounting the input so a blur
      // triggered by the removal (with its stale pre-Escape closure) can't
      // re-fire commitRename and commit the abandoned edit.
      committedRef.current = true;
      setEditName(initialName);
      setEditing(false);
    }
  }, [commitRename, initialName]);

  return { editing, setEditing, editName, setEditName, showMenu, setShowMenu, inputRef, menuRef, commitRename, handleKeyDown };
}
