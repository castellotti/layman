import { useState, useEffect, useRef, useCallback } from 'react';
import type { KeyboardEvent } from 'react';

export function useInlineEdit(initialName: string, onCommit: (name: string) => void) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(initialName);
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
    if (trimmed && trimmed !== initialName) {
      onCommit(trimmed);
    } else {
      setEditName(initialName);
    }
    setEditing(false);
  }, [editName, initialName, onCommit]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') {
      setEditName(initialName);
      setEditing(false);
    }
  }, [commitRename, initialName]);

  return { editing, setEditing, editName, setEditName, showMenu, setShowMenu, inputRef, menuRef, commitRename, handleKeyDown };
}
