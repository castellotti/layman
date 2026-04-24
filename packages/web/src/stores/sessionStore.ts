import { create } from 'zustand';
import type { TimelineEvent, PendingApprovalDTO, LaymanConfig, SessionStatus, SetupStatus, BookmarkFolder, Bookmark, SessionTimeMetrics, SessionAccessLog, SessionMetrics, DriftState } from '../lib/types.js';
import type { SessionInfo } from '../lib/ws-protocol.js';

interface InvestigationState {
  [eventId: string]: {
    questions: Array<{ question: string; answer: string; tokens?: { input: number; output: number }; latencyMs?: number; model?: string }>;
    isAnalyzing: boolean;
    analysisError?: string;
  };
}

export interface SessionState {
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
  setupModalDismissed: boolean;
  setupWizardDismissed: boolean;

  // Bookmarks
  bookmarksOpen: boolean;
  bookmarkFolders: BookmarkFolder[];
  bookmarks: Bookmark[];
  viewingSessionId: string | null;
  historicalEvents: TimelineEvent[];
  sessionTimeMetrics: SessionTimeMetrics | null;

  // Flowchart view
  flowchartOpen: boolean;
  flowchartViewMode: 'graph' | 'timeline';

  // Dashboard view
  dashboardOpen: boolean;
  dashboardFocusedSession: string | null;
  dashboardSessionOrder: string[];
  dashboardDismissedSessions: Set<string>;
  returnToDashboard: boolean;
  scrollToEventId: string | null;

  // Access log
  accessLogOpen: boolean;
  accessLogData: SessionAccessLog | null;

  // Session metrics from StatusLine (latest per session)
  sessionMetrics: Map<string, SessionMetrics>;

  // Drift monitoring state (latest per session)
  driftState: Map<string, DriftState>;

  // Sessions that have had user-initiated investigation interactions
  investigatedSessions: Set<string>;

  // Session summary
  sessionSummary: string | null;
  sessionSummaryHistory: Array<{ summary: string; generatedAt: number; sessionId: string | null }>;
  sessionSummaryError: string | null;
  isSummarizingSession: boolean;

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
  dismissSetupModal: () => void;
  dismissSetupWizard: () => void;
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
  setSessionTimeMetrics: (metrics: SessionTimeMetrics | null) => void;
  setFlowchartOpen: (open: boolean) => void;
  setFlowchartViewMode: (mode: 'graph' | 'timeline') => void;
  setDashboardOpen: (open: boolean) => void;
  setDashboardFocusedSession: (id: string | null) => void;
  setDashboardSessionOrder: (order: string[]) => void;
  dismissDashboardSession: (sessionId: string) => void;
  navigateFromDashboard: (sessionId: string, eventId: string) => void;
  navigateFromDashboardToLogs: (sessionId: string, eventId: string) => void;
  clearScrollToEvent: () => void;
  returnFromDashboardDrilldown: () => void;
  setAccessLogOpen: (open: boolean) => void;
  setAccessLogData: (data: SessionAccessLog | null) => void;
  fetchAccessLog: (sessionId: string) => Promise<void>;
  fetchSessionSummary: (sessionId: string | null, model?: string) => Promise<void>;
  clearSessionSummary: () => void;
  clearSessionSummaryError: () => void;
  setDriftState: (sessionId: string, state: DriftState) => void;
  markSessionInvestigated: (sessionId: string) => void;
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
  setupModalDismissed: false,
  setupWizardDismissed: false,

  bookmarksOpen: false,
  bookmarkFolders: [],
  bookmarks: [],
  viewingSessionId: null,
  historicalEvents: [],
  sessionTimeMetrics: null,

  flowchartOpen: false,
  flowchartViewMode: 'graph' as const,

  dashboardOpen: true,
  dashboardFocusedSession: null,
  dashboardSessionOrder: [],
  dashboardDismissedSessions: new Set<string>(),
  returnToDashboard: false,
  scrollToEventId: null,

  accessLogOpen: false,
  accessLogData: null,

  sessionMetrics: new Map(),

  driftState: new Map(),

  investigatedSessions: new Set<string>(),

  sessionSummary: null,
  sessionSummaryHistory: [],
  sessionSummaryError: null,
  isSummarizingSession: false,

  setConnected: (connected) => set({ connected }),

  setWsStatus: (wsStatus) =>
    set({ wsStatus, connected: wsStatus === 'connected' }),

  setServerVersion: (serverVersion) => set({ serverVersion }),

  addEvent: (event) =>
    set((state) => {
      // Route session_metrics events to the dedicated map instead of the timeline
      if (event.type === 'session_metrics') {
        const newMetrics = new Map(state.sessionMetrics);
        newMetrics.set(event.sessionId, {
          modelId: event.data.modelId,
          modelDisplayName: event.data.modelDisplayName,
          costUsd: event.data.costUsd,
          durationMs: event.data.durationMs,
          apiDurationMs: event.data.apiDurationMs,
          linesAdded: event.data.linesAdded,
          linesRemoved: event.data.linesRemoved,
          totalInputTokens: event.data.totalInputTokens,
          totalOutputTokens: event.data.totalOutputTokens,
          contextWindowSize: event.data.contextWindowSize,
          currentInputTokens: event.data.currentInputTokens,
          currentOutputTokens: event.data.currentOutputTokens,
          cacheReadTokens: event.data.cacheReadTokens,
          cacheCreationTokens: event.data.cacheCreationTokens,
          contextUsedPct: event.data.contextUsedPct,
          contextRemainingPct: event.data.contextRemainingPct,
          exceeds200kTokens: event.data.exceeds200kTokens,
          rateLimit5hrPct: event.data.rateLimit5hrPct,
          rateLimit5hrResetsAt: event.data.rateLimit5hrResetsAt,
          rateLimit7dayPct: event.data.rateLimit7dayPct,
          rateLimit7dayResetsAt: event.data.rateLimit7dayResetsAt,
          sessionName: event.data.sessionName,
          claudeCodeVersion: event.data.claudeCodeVersion,
          timestamp: event.timestamp,
        });
        return { sessionMetrics: newMetrics };
      }

      // If this session was manually dismissed, auto-restore it on new activity
      let dashboardDismissedSessions = state.dashboardDismissedSessions;
      if (dashboardDismissedSessions.has(event.sessionId)) {
        dashboardDismissedSessions = new Set(dashboardDismissedSessions);
        dashboardDismissedSessions.delete(event.sessionId);
      }

      // Deduplicate by id
      const existing = state.events.findIndex((e) => e.id === event.id);
      if (existing >= 0) {
        const newEvents = [...state.events];
        newEvents[existing] = { ...newEvents[existing], ...event };
        return { events: newEvents, dashboardDismissedSessions };
      }
      return { events: [...state.events, event], dashboardDismissedSessions };
    }),

  updateEvent: (eventId, updates) =>
    set((state) => {
      const result: Partial<SessionState> = {};
      const idx = state.events.findIndex((e) => e.id === eventId);
      if (idx >= 0) {
        const newEvents = [...state.events];
        newEvents[idx] = { ...newEvents[idx], ...updates };
        result.events = newEvents;
      }
      const hidx = state.historicalEvents.findIndex((e) => e.id === eventId);
      if (hidx >= 0) {
        const newHist = [...state.historicalEvents];
        newHist[hidx] = { ...newHist[hidx], ...updates };
        result.historicalEvents = newHist;
      }
      return result;
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
      // The server includes `active` in sessions:list (based on gate state). Prefer the
      // server's value; fall back to local state for any session the server didn't annotate.
      const existingActive = new Map(state.sessions.map(s => [s.sessionId, s.active]));
      const merged = sessions.map(s => ({
        ...s,
        active: s.active !== undefined ? s.active : existingActive.get(s.sessionId),
      }));

      // Auto-select when transitioning to exactly 1 session and none is currently selected
      if (merged.length === 1 && state.activeSessionId === null) {
        return { sessions: merged, activeSessionId: merged[0].sessionId };
      }
      // Switch to the newest session when the setting is enabled and a new session appears
      if (state.config?.switchToNewestSession && merged.length > state.sessions.length) {
        const existingIds = new Set(state.sessions.map((s) => s.sessionId));
        const newSessions = merged.filter((s) => !existingIds.has(s.sessionId));
        if (newSessions.length > 0) {
          const newest = newSessions.reduce((a, b) => (b.lastSeen > a.lastSeen ? b : a));
          return { sessions: merged, activeSessionId: newest.sessionId };
        }
      }
      return { sessions: merged, activeSessionId: state.activeSessionId };
    }),

  setActiveSession: (activeSessionId) => set({ activeSessionId }),

  setSetupStatus: (setupStatus) => set({ setupStatus }),

  dismissSetupBanner: () => set({ setupBannerDismissed: true }),

  dismissSetupModal: () => set({ setupModalDismissed: true }),

  dismissSetupWizard: () => set({ setupWizardDismissed: true }),

  markSessionActive: (sessionId) =>
    set((state) => {
      const newDismissed = new Set(state.dashboardDismissedSessions);
      newDismissed.delete(sessionId);
      const exists = state.sessions.some(s => s.sessionId === sessionId);
      if (exists) {
        return {
          sessions: state.sessions.map(s => s.sessionId === sessionId ? { ...s, active: true } : s),
          dashboardDismissedSessions: newDismissed,
        };
      }
      return {
        sessions: [...state.sessions, { sessionId, cwd: '', lastSeen: Date.now(), agentType: 'claude-code', active: true }],
        dashboardDismissedSessions: newDismissed,
      };
    }),

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
      sessionTimeMetrics: viewingSessionId === null ? null : state.sessionTimeMetrics,
    })),

  setHistoricalEvents: (historicalEvents) => set({ historicalEvents }),

  setSessionTimeMetrics: (sessionTimeMetrics) => set({ sessionTimeMetrics }),

  setFlowchartOpen: (open) => set({ flowchartOpen: open }),
  setFlowchartViewMode: (mode) => set({ flowchartViewMode: mode }),

  setDashboardOpen: (open) => set((state) => ({
    dashboardOpen: open,
    // When opening dashboard, close flowchart; when closing, clear return flag
    ...(open ? { flowchartOpen: false } : { returnToDashboard: false }),
  })),
  setDashboardFocusedSession: (id) => set({ dashboardFocusedSession: id }),
  setDashboardSessionOrder: (order) => set({ dashboardSessionOrder: order }),
  dismissDashboardSession: (sessionId) =>
    set((state) => {
      const newDismissed = new Set(state.dashboardDismissedSessions);
      newDismissed.add(sessionId);
      return { dashboardDismissedSessions: newDismissed };
    }),
  navigateFromDashboard: (sessionId, eventId) => set({
    dashboardOpen: false,
    returnToDashboard: true,
    flowchartOpen: true,
    flowchartViewMode: 'graph',
    activeSessionId: sessionId,
    selectedEventId: eventId,
    investigationOpen: true,
  }),
  navigateFromDashboardToLogs: (sessionId, eventId) => set({
    dashboardOpen: false,
    returnToDashboard: true,
    flowchartOpen: false,
    activeSessionId: sessionId,
    selectedEventId: eventId,
    investigationOpen: true,
    scrollToEventId: eventId,
  }),
  clearScrollToEvent: () => set({ scrollToEventId: null }),
  returnFromDashboardDrilldown: () => set({
    dashboardOpen: true,
    returnToDashboard: false,
    flowchartOpen: false,
    investigationOpen: false,
    selectedEventId: null,
  }),
  setAccessLogOpen: (open) => set({ accessLogOpen: open }),
  setAccessLogData: (data) => set({ accessLogData: data }),
  fetchAccessLog: async (sessionId) => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/access-log`);
      if (res.ok) {
        const data = await res.json() as SessionAccessLog;
        set({ accessLogData: data, accessLogOpen: true });
      }
    } catch {
      // Non-fatal
    }
  },

  clearSessionSummary: () => set({ sessionSummary: null, sessionSummaryHistory: [], sessionSummaryError: null }),
  clearSessionSummaryError: () => set({ sessionSummaryError: null }),

  fetchSessionSummary: async (sessionId, model) => {
    if (sessionId) useSessionStore.getState().markSessionInvestigated(sessionId);
    set({ isSummarizingSession: true, sessionSummaryError: null });
    try {
      const res = await fetch('/api/sessions/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, ...(model ? { model } : {}) }),
      });
      const data = await res.json() as { summary?: string; error?: string };
      if (res.ok && data.summary) {
        const entry = { summary: data.summary, generatedAt: Date.now(), sessionId: sessionId ?? null };
        set((state) => ({
          sessionSummary: data.summary!,
          sessionSummaryHistory: [...state.sessionSummaryHistory, entry],
          sessionSummaryError: null,
        }));
      } else {
        set({ sessionSummaryError: data.error ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      set({ sessionSummaryError: err instanceof Error ? err.message : 'Network error' });
    } finally {
      set({ isSummarizingSession: false });
    }
  },

  setDriftState: (sessionId, driftData) =>
    set((prev) => {
      const newMap = new Map(prev.driftState);
      newMap.set(sessionId, driftData);
      return { driftState: newMap };
    }),

  markSessionInvestigated: (sessionId) =>
    set((prev) => {
      if (prev.investigatedSessions.has(sessionId)) return prev;
      const newSet = new Set(prev.investigatedSessions);
      newSet.add(sessionId);
      return { investigatedSessions: newSet };
    }),
}));
