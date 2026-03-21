import { create } from 'zustand';
import type { TimelineEvent, PendingApprovalDTO, LaymanConfig, SessionStatus, SetupStatus, BookmarkFolder, Bookmark } from '../lib/types.js';
import type { SessionInfo } from '../lib/ws-protocol.js';

interface InvestigationState {
  [eventId: string]: {
    questions: Array<{ question: string; answer: string; tokens?: { input: number; output: number }; latencyMs?: number; model?: string }>;
    isAnalyzing: boolean;
    analysisError?: string;
  };
}

interface SessionState {
  // Connection
  connected: boolean;
  serverVersion: string;
  wsStatus: 'connecting' | 'connected' | 'disconnected' | 'error';

  // Events
  events: TimelineEvent[];
  selectedEventId: string | null;

  // Pending approvals
  pendingApprovals: Map<string, PendingApprovalDTO>;

  // Analysis in-flight
  analyzingEventIds: Set<string>;

  // Laymans in-flight
  laymansEventIds: Set<string>;
  laymansErrors: Record<string, string>;

  // Investigation panel
  investigationOpen: boolean;
  investigationState: InvestigationState;

  // Settings
  settingsOpen: boolean;
  config: LaymanConfig | null;

  // Session status
  sessionStatus: SessionStatus | null;

  // Multi-session tracking
  sessions: SessionInfo[];
  activeSessionId: string | null;

  // Setup status
  setupStatus: SetupStatus | null;
  setupBannerDismissed: boolean;

  // Bookmarks
  bookmarksOpen: boolean;
  bookmarkFolders: BookmarkFolder[];
  bookmarks: Bookmark[];
  viewingSessionId: string | null;
  historicalEvents: TimelineEvent[];

  // Actions
  setConnected: (connected: boolean) => void;
  setWsStatus: (status: SessionState['wsStatus']) => void;
  setServerVersion: (version: string) => void;
  addEvent: (event: TimelineEvent) => void;
  updateEvent: (eventId: string, updates: Partial<TimelineEvent>) => void;
  setSelectedEvent: (id: string | null) => void;
  addPendingApproval: (approval: PendingApprovalDTO) => void;
  removePendingApproval: (id: string) => void;
  setAnalyzing: (eventId: string, analyzing: boolean) => void;
  setAnalysisError: (eventId: string, error: string | null) => void;
  setLaymans: (eventId: string, loading: boolean) => void;
  setLaymansError: (eventId: string, error: string | null) => void;
  addInvestigationQuestion: (eventId: string, question: string, answer: string, meta?: { tokens?: { input: number; output: number }; latencyMs?: number; model?: string }) => void;
  setInvestigationOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setConfig: (config: LaymanConfig) => void;
  setSessionStatus: (status: SessionStatus) => void;
  setSessions: (sessions: SessionInfo[]) => void;
  setActiveSession: (id: string | null) => void;
  setSetupStatus: (status: SetupStatus) => void;
  dismissSetupBanner: () => void;
  markSessionActive: (sessionId: string) => void;
  markSessionInactive: (sessionId: string) => void;
  clearEvents: () => void;
  setBookmarksOpen: (open: boolean) => void;
  setBookmarks: (folders: BookmarkFolder[], bookmarks: Bookmark[]) => void;
  upsertFolder: (folder: BookmarkFolder) => void;
  removeFolder: (folderId: string) => void;
  upsertBookmark: (bookmark: Bookmark) => void;
  removeBookmark: (bookmarkId: string) => void;
  setViewingSession: (sessionId: string | null) => void;
  setHistoricalEvents: (events: TimelineEvent[]) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  connected: false,
  serverVersion: '',
  wsStatus: 'connecting',

  events: [],
  selectedEventId: null,

  pendingApprovals: new Map(),
  analyzingEventIds: new Set(),
  laymansEventIds: new Set(),
  laymansErrors: {},

  investigationOpen: false,
  investigationState: {},

  settingsOpen: false,
  config: null,
  sessionStatus: null,

  sessions: [],
  activeSessionId: null,

  setupStatus: null,
  setupBannerDismissed: false,

  bookmarksOpen: false,
  bookmarkFolders: [],
  bookmarks: [],
  viewingSessionId: null,
  historicalEvents: [],

  setConnected: (connected) => set({ connected }),

  setWsStatus: (wsStatus) =>
    set({ wsStatus, connected: wsStatus === 'connected' }),

  setServerVersion: (serverVersion) => set({ serverVersion }),

  addEvent: (event) =>
    set((state) => {
      // Deduplicate by id
      const existing = state.events.findIndex((e) => e.id === event.id);
      if (existing >= 0) {
        const newEvents = [...state.events];
        newEvents[existing] = { ...newEvents[existing], ...event };
        return { events: newEvents };
      }
      return { events: [...state.events, event] };
    }),

  updateEvent: (eventId, updates) =>
    set((state) => {
      const idx = state.events.findIndex((e) => e.id === eventId);
      if (idx < 0) return {};
      const newEvents = [...state.events];
      newEvents[idx] = { ...newEvents[idx], ...updates };
      return { events: newEvents };
    }),

  setSelectedEvent: (id) =>
    set({ selectedEventId: id, investigationOpen: id !== null }),

  addPendingApproval: (approval) =>
    set((state) => {
      const newMap = new Map(state.pendingApprovals);
      newMap.set(approval.id, approval);
      return { pendingApprovals: newMap };
    }),

  removePendingApproval: (id) =>
    set((state) => {
      const newMap = new Map(state.pendingApprovals);
      newMap.delete(id);
      return { pendingApprovals: newMap };
    }),

  setAnalyzing: (eventId, analyzing) =>
    set((state) => {
      const newSet = new Set(state.analyzingEventIds);
      if (analyzing) {
        newSet.add(eventId);
      } else {
        newSet.delete(eventId);
      }
      return { analyzingEventIds: newSet };
    }),

  setAnalysisError: (eventId, error) =>
    set((state) => {
      const existing = state.investigationState[eventId] ?? { questions: [], isAnalyzing: false };
      return {
        investigationState: {
          ...state.investigationState,
          [eventId]: { ...existing, analysisError: error ?? undefined },
        },
      };
    }),

  setLaymans: (eventId, loading) =>
    set((state) => {
      const newSet = new Set(state.laymansEventIds);
      if (loading) {
        newSet.add(eventId);
      } else {
        newSet.delete(eventId);
      }
      return { laymansEventIds: newSet };
    }),

  setLaymansError: (eventId, error) =>
    set((state) => ({
      laymansErrors: {
        ...state.laymansErrors,
        [eventId]: error ?? '',
      },
    })),

  addInvestigationQuestion: (eventId, question, answer, meta) =>
    set((state) => {
      const existing = state.investigationState[eventId] ?? {
        questions: [],
        isAnalyzing: false,
      };
      return {
        investigationState: {
          ...state.investigationState,
          [eventId]: {
            ...existing,
            questions: [...existing.questions, { question, answer, ...meta }],
          },
        },
      };
    }),

  setInvestigationOpen: (open) => set({ investigationOpen: open }),

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  setConfig: (config) => set({ config }),

  setSessionStatus: (sessionStatus) => set({ sessionStatus }),

  setSessions: (sessions) =>
    set((state) => {
      // Auto-select when transitioning to exactly 1 session and none is currently selected
      const autoSelect =
        sessions.length === 1 && state.activeSessionId === null
          ? sessions[0].sessionId
          : state.activeSessionId;
      return { sessions, activeSessionId: autoSelect };
    }),

  setActiveSession: (activeSessionId) => set({ activeSessionId }),

  setSetupStatus: (setupStatus) => set({ setupStatus }),

  dismissSetupBanner: () => set({ setupBannerDismissed: true }),

  markSessionActive: (sessionId) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.sessionId === sessionId ? { ...s, active: true } : s
      ),
    })),

  markSessionInactive: (sessionId) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.sessionId === sessionId ? { ...s, active: false } : s
      ),
    })),

  clearEvents: () => set({ events: [], selectedEventId: null }),

  setBookmarksOpen: (open) => set({ bookmarksOpen: open }),

  setBookmarks: (bookmarkFolders, bookmarks) => set({ bookmarkFolders, bookmarks }),

  upsertFolder: (folder) =>
    set((state) => {
      const idx = state.bookmarkFolders.findIndex((f) => f.id === folder.id);
      if (idx >= 0) {
        const updated = [...state.bookmarkFolders];
        updated[idx] = folder;
        return { bookmarkFolders: updated };
      }
      return { bookmarkFolders: [...state.bookmarkFolders, folder] };
    }),

  removeFolder: (folderId) =>
    set((state) => ({
      bookmarkFolders: state.bookmarkFolders.filter((f) => f.id !== folderId),
      // Orphaned bookmarks become unfiled (their folderId will be null server-side via ON DELETE SET NULL)
    })),

  upsertBookmark: (bookmark) =>
    set((state) => {
      const idx = state.bookmarks.findIndex((b) => b.id === bookmark.id);
      if (idx >= 0) {
        const updated = [...state.bookmarks];
        updated[idx] = bookmark;
        return { bookmarks: updated };
      }
      return { bookmarks: [...state.bookmarks, bookmark] };
    }),

  removeBookmark: (bookmarkId) =>
    set((state) => ({
      bookmarks: state.bookmarks.filter((b) => b.id !== bookmarkId),
    })),

  setViewingSession: (viewingSessionId) =>
    set((state) => ({
      viewingSessionId,
      historicalEvents: viewingSessionId === null ? [] : state.historicalEvents,
    })),

  setHistoricalEvents: (historicalEvents) => set({ historicalEvents }),
}));
