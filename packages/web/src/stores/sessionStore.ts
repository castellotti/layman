import { create } from 'zustand';
import type { TimelineEvent, PendingApprovalDTO, LaymanConfig, SessionStatus, SetupStatus, BookmarkFolder, Bookmark, HighlightFolder, Highlight, SessionTimeMetrics, SessionAccessLog, SessionMetrics, DriftState } from '../lib/types.js';
import type { SessionInfo } from '../lib/ws-protocol.js';

function computeHighlightedEventIds(highlights: Highlight[]): Set<string> {
  const ids = new Set<string>();
  for (const h of highlights) {
    ids.add(h.promptEventId);
    ids.add(h.responseEventId);
  }
  return ids;
}

export type ViewMode = 'dashboard' | 'stream' | 'flowchart' | 'sessions' | 'prompts';

// ─── Expanding-interface layout state ──────────────────────────────────────

export type PinnedView = 'dashboard' | 'stream' | null;

export interface SplitOverrides {
  session?: number;
  dashboard?: number;
  investigation?: number;
}

export interface PanelLayout {
  showDashboard: boolean;
  showLogs: boolean;
  showInvestigation: boolean;
  showSettings: boolean;
  investigationPresentation: 'docked' | 'drawer';
  dashboardWidth: number;
  sessionListWidth: number;
  investigationWidth: number;
  logsDockThreshold: number;
  viewportWidth: number;
}

const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  showDashboard: true,
  showLogs: false,
  showInvestigation: false,
  showSettings: false,
  investigationPresentation: 'drawer',
  dashboardWidth: 0,
  sessionListWidth: 0,
  investigationWidth: 480,
  logsDockThreshold: 0,
  viewportWidth: 0,
};

const LOG_HIGHLIGHTS_STORAGE_KEY = 'layman.logHighlightedEventIds';

function loadLogHighlights(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(LOG_HIGHLIGHTS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveLogHighlights(ids: Set<string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LOG_HIGHLIGHTS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage may be unavailable (private browsing quota, etc.) — non-fatal.
  }
}

// dashboardOpen/flowchartOpen/bookmarksOpen/promptsOpen are derived from viewMode and kept in
// sync on every state change that touches it, so existing boolean-reading consumers keep working
// off a single source of truth instead of four independently-settable flags.
function viewModeFlags(mode: ViewMode) {
  return {
    dashboardOpen: mode === 'dashboard',
    flowchartOpen: mode === 'flowchart',
    bookmarksOpen: mode === 'sessions',
    promptsOpen: mode === 'prompts',
  };
}

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

  // View mode — single source of truth for top-level nav (see viewModeFlags)
  viewMode: ViewMode;

  // Bookmarks
  bookmarksOpen: boolean;
  bookmarkFolders: BookmarkFolder[];
  bookmarks: Bookmark[];
  viewingSessionId: string | null;
  historicalEvents: TimelineEvent[];
  sessionTimeMetrics: SessionTimeMetrics | null;
  bookmarksScrollToEventId: string | null;

  // Highlights (Prompts view)
  promptsOpen: boolean;
  highlightFolders: HighlightFolder[];
  highlights: Highlight[];
  highlightedEventIds: Set<string>;

  // Flowchart view
  flowchartOpen: boolean;

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

  // Expanding-interface layout: pin a single live view full-width, or let width drive it
  pinnedView: PinnedView;
  splitOverrides: SplitOverrides;
  panelLayout: PanelLayout;

  // Logs detail-card highlight (local, persisted to localStorage — distinct from the
  // server-backed Highlights/Prompts folder feature above)
  logHighlightedEventIds: Set<string>;

  // Logs expand/collapse state — 'all' means every row with a detail payload is expanded
  expandedLogEventIds: Set<string> | 'all';

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
  setViewMode: (mode: ViewMode) => void;
  setBookmarks: (folders: BookmarkFolder[], bookmarks: Bookmark[]) => void;
  upsertFolder: (folder: BookmarkFolder) => void;
  removeFolder: (folderId: string) => void;
  upsertBookmark: (bookmark: Bookmark) => void;
  removeBookmark: (bookmarkId: string) => void;
  setViewingSession: (sessionId: string | null) => void;
  setHistoricalEvents: (events: TimelineEvent[]) => void;
  setSessionTimeMetrics: (metrics: SessionTimeMetrics | null) => void;
  setBookmarksScrollToEventId: (eventId: string | null) => void;
  setHighlights: (folders: HighlightFolder[], highlights: Highlight[]) => void;
  upsertHighlightFolder: (folder: HighlightFolder) => void;
  removeHighlightFolder: (folderId: string) => void;
  upsertHighlight: (highlight: Highlight) => void;
  removeHighlight: (highlightId: string) => void;
  navigateFromPromptsToSession: (sessionId: string, promptEventId: string) => void;
  setDashboardFocusedSession: (id: string | null) => void;
  setDashboardSessionOrder: (order: string[]) => void;
  dismissDashboardSession: (sessionId: string) => void;
  navigateFromDashboard: (sessionId: string, eventId: string) => void;
  navigateFromDashboardToLogs: (sessionId: string, eventId: string) => void;
  navigateToLogsForSession: (sessionId: string) => void;
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

  togglePinnedView: (view: 'dashboard' | 'stream') => void;
  setSplitOverride: (key: keyof SplitOverrides, value: number) => void;
  resetSplitOverrides: () => void;
  setPanelLayout: (layout: PanelLayout) => void;
  toggleLogHighlight: (eventId: string) => void;
  setExpandedLogEventIds: (ids: Set<string> | 'all') => void;
  toggleExpandAllLogs: (detailEventIds: string[]) => void;
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

  viewMode: 'dashboard',

  bookmarksOpen: false,
  bookmarkFolders: [],
  bookmarks: [],
  viewingSessionId: null,
  historicalEvents: [],
  sessionTimeMetrics: null,
  bookmarksScrollToEventId: null,

  promptsOpen: false,
  highlightFolders: [],
  highlights: [],
  highlightedEventIds: new Set<string>(),

  flowchartOpen: false,

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

  pinnedView: null,
  splitOverrides: {},
  panelLayout: DEFAULT_PANEL_LAYOUT,

  logHighlightedEventIds: loadLogHighlights(),

  expandedLogEventIds: 'all',

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

  setViewMode: (mode) => set({
    viewMode: mode,
    ...viewModeFlags(mode),
    ...(mode !== 'dashboard' ? { returnToDashboard: false } : {}),
  }),

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

  setBookmarksScrollToEventId: (eventId) => set({ bookmarksScrollToEventId: eventId }),

  setHighlights: (highlightFolders, highlights) =>
    set({ highlightFolders, highlights, highlightedEventIds: computeHighlightedEventIds(highlights) }),

  upsertHighlightFolder: (folder) =>
    set((state) => {
      const idx = state.highlightFolders.findIndex((f) => f.id === folder.id);
      if (idx >= 0) {
        const updated = [...state.highlightFolders];
        updated[idx] = folder;
        return { highlightFolders: updated };
      }
      return { highlightFolders: [...state.highlightFolders, folder] };
    }),

  removeHighlightFolder: (folderId) =>
    set((state) => {
      const updated = state.highlights.map((h) =>
        h.folderId === folderId ? { ...h, folderId: null } : h
      );
      return {
        highlightFolders: state.highlightFolders.filter((f) => f.id !== folderId),
        highlights: updated,
        highlightedEventIds: computeHighlightedEventIds(updated),
      };
    }),

  upsertHighlight: (highlight) =>
    set((state) => {
      const idx = state.highlights.findIndex((h) => h.id === highlight.id);
      let newHighlights: Highlight[];
      if (idx >= 0) {
        newHighlights = [...state.highlights];
        newHighlights[idx] = highlight;
      } else {
        newHighlights = [...state.highlights, highlight];
      }
      return { highlights: newHighlights, highlightedEventIds: computeHighlightedEventIds(newHighlights) };
    }),

  removeHighlight: (highlightId) =>
    set((state) => {
      const newHighlights = state.highlights.filter((h) => h.id !== highlightId);
      return { highlights: newHighlights, highlightedEventIds: computeHighlightedEventIds(newHighlights) };
    }),

  navigateFromPromptsToSession: (sessionId, promptEventId) => set({
    viewMode: 'sessions',
    ...viewModeFlags('sessions'),
    viewingSessionId: sessionId,
    bookmarksScrollToEventId: promptEventId,
  }),

  setViewingSession: (viewingSessionId) =>
    set((state) => ({
      viewingSessionId,
      historicalEvents: viewingSessionId === null ? [] : state.historicalEvents,
      sessionTimeMetrics: viewingSessionId === null ? null : state.sessionTimeMetrics,
    })),

  setHistoricalEvents: (historicalEvents) => set({ historicalEvents }),

  setSessionTimeMetrics: (sessionTimeMetrics) => set({ sessionTimeMetrics }),

  setDashboardFocusedSession: (id) => set({ dashboardFocusedSession: id }),
  setDashboardSessionOrder: (order) => set({ dashboardSessionOrder: order }),
  dismissDashboardSession: (sessionId) =>
    set((state) => {
      const newDismissed = new Set(state.dashboardDismissedSessions);
      newDismissed.add(sessionId);
      return { dashboardDismissedSessions: newDismissed };
    }),
  navigateFromDashboard: (sessionId, eventId) => set({
    viewMode: 'flowchart',
    ...viewModeFlags('flowchart'),
    returnToDashboard: true,
    activeSessionId: sessionId,
    selectedEventId: eventId,
    investigationOpen: true,
  }),
  navigateFromDashboardToLogs: (sessionId, eventId) => set({
    viewMode: 'stream',
    ...viewModeFlags('stream'),
    returnToDashboard: true,
    activeSessionId: sessionId,
    selectedEventId: eventId,
    investigationOpen: true,
    scrollToEventId: eventId,
  }),
  navigateToLogsForSession: (sessionId) => set((state) => ({
    viewMode: 'stream',
    ...viewModeFlags('stream'),
    returnToDashboard: state.dashboardOpen,
    activeSessionId: sessionId,
    selectedEventId: null,
    investigationOpen: false,
    scrollToEventId: null,
  })),
  clearScrollToEvent: () => set({ scrollToEventId: null }),
  returnFromDashboardDrilldown: () => set({
    viewMode: 'dashboard',
    ...viewModeFlags('dashboard'),
    returnToDashboard: false,
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

  // Clicking a pinned Dashboard/Logs tab (or its D/S shortcut) again unpins and
  // returns to width-driven auto-expand. Pinning always clears divider overrides
  // since the visible panel set is about to change.
  togglePinnedView: (view) =>
    set((state) => ({
      pinnedView: state.pinnedView === view ? null : view,
      splitOverrides: {},
    })),

  setSplitOverride: (key, value) =>
    set((state) => ({ splitOverrides: { ...state.splitOverrides, [key]: value } })),

  resetSplitOverrides: () => set({ splitOverrides: {} }),

  setPanelLayout: (panelLayout) => set({ panelLayout }),

  toggleLogHighlight: (eventId) =>
    set((state) => {
      const next = new Set(state.logHighlightedEventIds);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      saveLogHighlights(next);
      return { logHighlightedEventIds: next };
    }),

  setExpandedLogEventIds: (expandedLogEventIds) => set({ expandedLogEventIds }),

  // Flips the whole Logs list between fully expanded and fully collapsed, based on
  // whether every row with a detail payload is currently expanded.
  toggleExpandAllLogs: (detailEventIds) =>
    set((state) => {
      const effective =
        state.expandedLogEventIds === 'all' ? new Set(detailEventIds) : state.expandedLogEventIds;
      const allExpanded = detailEventIds.length > 0 && detailEventIds.every((id) => effective.has(id));
      return { expandedLogEventIds: allExpanded ? new Set<string>() : 'all' };
    }),
}));
