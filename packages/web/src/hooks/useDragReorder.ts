import { useCallback, useState } from 'react';

// Shared index-based drag-to-reorder interaction: tracks which item is being
// dragged and which item it's currently over, then hands off the (from, to)
// index pair on drop so the caller can apply its own persistence (store
// update, optimistic fetch, etc).
export function useDragReorder(onReorder: (fromIndex: number, toIndex: number) => void) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = useCallback((index: number) => setDragIndex(index), []);
  const handleDragOver = useCallback((index: number) => setDragOverIndex(index), []);
  const handleDragEnd = useCallback(() => {
    if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
      onReorder(dragIndex, dragOverIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, dragOverIndex, onReorder]);

  return { dragIndex, dragOverIndex, handleDragStart, handleDragOver, handleDragEnd };
}
