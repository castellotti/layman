import { useCallback, useEffect, useMemo, useState } from 'react';

// Optimistic client-side reordering with server persistence: applying a drag
// immediately updates the displayed order, then reverts to the server order
// if the persist call fails — so a failed reorder snaps back visibly instead
// of silently drifting from what's actually saved.
export function useOptimisticOrder<T>(
  serverItems: T[],
  getId: (item: T) => string,
  persist: (ids: string[]) => Promise<void>
) {
  const [localOrderIds, setLocalOrderIds] = useState<string[] | null>(null);

  // Clear local order once serverItems reflects our reorder (server confirmed)
  useEffect(() => {
    if (!localOrderIds) return;
    const serverIds = serverItems.map(getId).join(',');
    if (serverIds === localOrderIds.join(',')) setLocalOrderIds(null);
  }, [serverItems, localOrderIds, getId]);

  const items = useMemo(() => {
    if (!localOrderIds) return serverItems;
    const byId = new Map(serverItems.map((item) => [getId(item), item]));
    return localOrderIds.map((id) => byId.get(id)).filter((x): x is T => x !== undefined);
  }, [serverItems, localOrderIds, getId]);

  const reorder = useCallback((fromId: string, toId: string) => {
    const fromIdx = items.findIndex((item) => getId(item) === fromId);
    const toIdx = items.findIndex((item) => getId(item) === toId);
    if (fromIdx === -1 || toIdx === -1) return;

    const newItems = [...items];
    const [moved] = newItems.splice(fromIdx, 1);
    newItems.splice(toIdx, 0, moved);
    const newIds = newItems.map(getId);

    setLocalOrderIds(newIds);
    persist(newIds).catch(() => setLocalOrderIds(null));
  }, [items, getId, persist]);

  return { items, reorder };
}
