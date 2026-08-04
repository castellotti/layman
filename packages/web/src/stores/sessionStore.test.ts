import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from './sessionStore.js';
import type { Bookmark, BookmarkFolder } from '../lib/types.js';

function setPanel(showDashboard: boolean, showLogs: boolean) {
  useSessionStore.setState((state) => ({
    panelLayout: { ...state.panelLayout, showDashboard, showLogs },
  }));
}

beforeEach(() => {
  useSessionStore.setState({
    dashboardOverride: null,
    logsOverride: null,
    splitOverrides: {},
    bookmarks: [],
    bookmarkFolders: [],
  });
});

// Dashboard/Logs are two independent tabs: clicking the tab that's already
// active expands/collapses the *other* panel; clicking the inactive tab
// exclusively activates it (closing the other). See toggleDashboardVisible/
// toggleLogsVisible in sessionStore.ts.
describe('toggleDashboardVisible', () => {
  it('expands Logs alongside when Dashboard is the sole active tab', () => {
    setPanel(true, false);
    useSessionStore.getState().toggleDashboardVisible();
    const { dashboardOverride, logsOverride } = useSessionStore.getState();
    expect(dashboardOverride).toBe(true);
    expect(logsOverride).toBe(true);
  });

  it('collapses Logs when both panels are shown (Dashboard is the active tab)', () => {
    setPanel(true, true);
    useSessionStore.getState().toggleDashboardVisible();
    const { dashboardOverride, logsOverride } = useSessionStore.getState();
    expect(dashboardOverride).toBe(true);
    expect(logsOverride).toBe(false);
  });

  it('exclusively activates Dashboard when Logs is the sole active tab', () => {
    setPanel(false, true);
    useSessionStore.getState().toggleDashboardVisible();
    const { dashboardOverride, logsOverride } = useSessionStore.getState();
    expect(dashboardOverride).toBe(true);
    expect(logsOverride).toBe(false);
  });
});

describe('toggleLogsVisible', () => {
  it('exclusively activates Logs when Dashboard is the sole active tab', () => {
    setPanel(true, false);
    useSessionStore.getState().toggleLogsVisible();
    const { dashboardOverride, logsOverride } = useSessionStore.getState();
    expect(logsOverride).toBe(true);
    expect(dashboardOverride).toBe(false);
  });

  it('collapses Dashboard when both panels are shown (Logs is the active tab)', () => {
    setPanel(true, true);
    useSessionStore.getState().toggleLogsVisible();
    const { dashboardOverride, logsOverride } = useSessionStore.getState();
    expect(logsOverride).toBe(true);
    expect(dashboardOverride).toBe(false);
  });

  it('expands Dashboard alongside when Logs is the sole active tab', () => {
    setPanel(false, true);
    useSessionStore.getState().toggleLogsVisible();
    const { dashboardOverride, logsOverride } = useSessionStore.getState();
    expect(logsOverride).toBe(true);
    expect(dashboardOverride).toBe(true);
  });
});

describe('removeFolder', () => {
  it('reassigns bookmarks that were inside the deleted folder to unfiled', () => {
    const folder: BookmarkFolder = { id: 'f1', name: 'Folder', sortOrder: 0, createdAt: 0 };
    const inFolder: Bookmark = { id: 'b1', folderId: 'f1', sessionId: 's1', name: 'a', sortOrder: 0, createdAt: 0 };
    const elsewhere: Bookmark = { id: 'b2', folderId: null, sessionId: 's2', name: 'b', sortOrder: 0, createdAt: 0 };
    useSessionStore.setState({ bookmarkFolders: [folder], bookmarks: [inFolder, elsewhere] });

    useSessionStore.getState().removeFolder('f1');

    const { bookmarkFolders, bookmarks } = useSessionStore.getState();
    expect(bookmarkFolders).toHaveLength(0);
    expect(bookmarks.find((b) => b.id === 'b1')?.folderId).toBeNull();
    expect(bookmarks.find((b) => b.id === 'b2')?.folderId).toBeNull();
  });
});
