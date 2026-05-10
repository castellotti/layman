/** Snapshot a live session to SQLite then create a named bookmark.
 *  Returns false if the snapshot fails (e.g. recording disabled). */
export async function saveAndBookmarkSession(sessionId: string, name: string): Promise<boolean> {
  try {
    const snapRes = await fetch('/api/bookmarks/sessions/save-current', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!snapRes.ok) return false;
    await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, name, folderId: null }),
    });
    return true;
  } catch {
    return false;
  }
}
