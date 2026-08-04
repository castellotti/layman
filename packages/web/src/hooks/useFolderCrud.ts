import { useCallback } from 'react';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Create/rename/delete/reorder for a folder resource — bookmark folders and
 * highlight folders share the same REST shape, differing only in base URL
 * (`/api/bookmarks/folders` vs `/api/highlights/folders`).
 */
export function useFolderCrud(baseUrl: string) {
  const handleCreateFolder = useCallback((name: string) => {
    void fetch(baseUrl, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name }),
    }).catch(() => {});
  }, [baseUrl]);

  const handleRenameFolder = useCallback((folderId: string, name: string) => {
    void fetch(`${baseUrl}/${folderId}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name }),
    }).catch(() => {});
  }, [baseUrl]);

  const handleDeleteFolder = useCallback((folderId: string, onSettled?: () => void) => {
    void fetch(`${baseUrl}/${folderId}`, { method: 'DELETE' })
      .catch(() => {})
      .finally(() => onSettled?.());
  }, [baseUrl]);

  const persistFolderOrder = useCallback((ids: string[]) =>
    fetch(`${baseUrl}/reorder`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ids }),
    }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); }),
  [baseUrl]);

  return { handleCreateFolder, handleRenameFolder, handleDeleteFolder, persistFolderOrder };
}
