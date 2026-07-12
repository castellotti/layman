import { useCallback, useState } from 'react';

// Shared id-based drag-to-reorder interaction: tracks which item is being
// dragged and which item it's currently over, then hands off the (from, to)
// id pair on drop so the caller can apply its own persistence (store
// update, optimistic fetch, etc). Ids (not array indices) are used so a
// drag remains correct even if the underlying list reshuffles mid-drag
// (e.g. a live-updating session list).
export function useDragReorder(onReorder: (fromId: string, toId: string) => void) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const handleDragStart = useCallback((id: string) => setDragId(id), []);
  const handleDragOver = useCallback((id: string) => setDragOverId(id), []);
  const handleDragEnd = useCallback(() => {
    if (dragId !== null && dragOverId !== null && dragId !== dragOverId) {
      onReorder(dragId, dragOverId);
    }
    setDragId(null);
    setDragOverId(null);
  }, [dragId, dragOverId, onReorder]);

  return { dragId, dragOverId, handleDragStart, handleDragOver, handleDragEnd };
}
