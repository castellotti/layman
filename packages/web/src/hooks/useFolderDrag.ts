import { useCallback, useState } from 'react';

/** 'unfiled' is the no-folder bucket; 'history' is a drag source only (not a valid drop target). */
export type FolderContainerId = string;

export interface FolderDragSource {
  id: string;           // bookmark/highlight id, or the session id for a not-yet-bookmarked History row
  containerId: FolderContainerId;
  bookmarked: boolean;  // false only for History rows dragged before they exist as a bookmark
}

export interface FolderDropTarget {
  containerId: FolderContainerId;
  beforeId: string | null; // item to insert before within containerId; null = append at end
}

/**
 * Cross-container drag for the Sessions/Prompts bookmark sidebars. Unlike
 * useDragReorder (single flat list), state here is shared across every
 * folder + the Unfiled/History buckets, so a drag started in one container
 * and dropped in another can be told apart from a same-container reorder.
 */
export function useFolderDrag(onDrop: (source: FolderDragSource, target: FolderDropTarget) => void) {
  const [source, setSource] = useState<FolderDragSource | null>(null);
  const [target, setTarget] = useState<FolderDropTarget | null>(null);

  const handleDragStart = useCallback((next: FolderDragSource) => setSource(next), []);

  const handleDragOverItem = useCallback((containerId: FolderContainerId, beforeId: string) => {
    setTarget({ containerId, beforeId });
  }, []);

  const handleDragOverContainer = useCallback((containerId: FolderContainerId) => {
    setTarget({ containerId, beforeId: null });
  }, []);

  const handleDragEnd = useCallback(() => {
    if (source && target && target.containerId !== 'history') {
      onDrop(source, target);
    }
    setSource(null);
    setTarget(null);
  }, [source, target, onDrop]);

  return {
    draggedId: source?.id ?? null,
    dragOverContainerId: target?.containerId ?? null,
    dragOverItemId: target?.beforeId ?? null,
    handleDragStart,
    handleDragOverItem,
    handleDragOverContainer,
    handleDragEnd,
  };
}
