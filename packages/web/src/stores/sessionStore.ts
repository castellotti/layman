import { create } from 'zustand';
import type { TimelineEvent, PendingApprovalDTO, LaymanConfig, SessionStatus, SetupStatus, BookmarkFolder, Bookmark, HighlightFolder, Highlight, SessionTimeMetrics, SessionAccessLog, SessionMetrics, DriftState, ResolvedId } from '../lib/types.js';
import type { SessionInfo } from '../lib/ws-protocol.js';
import type { LaymanRoute, RouteOptions, ViewName } from '../lib/layman-url.js';
import { extractTurn } from '../lib/turns.js';
import { pairFor } from '../lib/event-pairing.js';

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

export interface SplitOverrides {
  session?: number;
  dashboard?: number;
  investigation?: number;
}

export interface PanelLayout {
  showDashboard: boolean;
  showLogs: boolean;
  showInvestigation: boolean;
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

// flowchartOpen/bookmarksOpen/promptsOpen are derived from viewMode and kept in
// sync on every state change that touches it, so existing boolean-reading consumers keep working
// off a single source of truth instead of three independently-settable flags.
function viewModeFlags(mode: ViewMode) {
  return {
    flowchartOpen: mode === 'flowchart',
    bookmarksOpen: mode === 'sessions',
    promptsOpen: mode === 'prompts',
  };
}

// ─── URL ↔ view mode ───────────────────────────────────────────────────────
// The URL grammar's `?view=` names are user-facing and stable; ViewMode is
// internal and predates them. These two maps are the only place they meet.

const VIEW_NAME_BY_MODE: Record<ViewMode, ViewName> = {
  dashboard: 'dashboard',
  stream: 'logs',
  flowchart: 'flow',
  sessions: 'sessions',
  prompts: 'prompts',
};

const MODE_BY_VIEW_NAME: Record<ViewName, ViewMode> = {
  dashboard: 'dashboard',
  logs: 'stream',
  flow: 'flowchart',
  sessions: 'sessions',
  prompts: 'prompts',
};

export function viewNameForMode(mode: ViewMode): ViewName {
  return VIEW_NAME_BY_MODE[mode];
}

export function viewModeForName(name: ViewName): ViewMode {
  return MODE_BY_VIEW_NAME[name];
}

/** The base URL this instance advertises for links it generates. */
export function instanceUrlOf(config: LaymanConfig | null): string {
  const configured = config?.publicUrl?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  // Correct for the common single-machine case, and for a hub browsed over the LAN.
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/**
 * A session's events, preferring the recorded copy. Falls back to whatever the
 * live store holds, which is the only source when sessionRecording is off.
 */
async function fetchSessionEvents(
  sessionId: string,
): Promise<{ events: TimelineEvent[]; metrics: SessionTimeMetrics | null }> {
  try {
    const [evRes, metricsRes] = await Promise.all([
      fetch(`/api/bookmarks/sessions/${encodeURIComponent(sessionId)}/events`),
      fetch(`/api/bookmarks/sessions/${encodeURIComponent(sessionId)}/time-metrics`),
    ]);
    const evData = await evRes.json() as { events?: TimelineEvent[] };
    const metrics = metricsRes.ok ? await metricsRes.json() as SessionTimeMetrics : null;
    return { events: evData.events ?? [], metrics };
  } catch {
    return { events: [], metrics: null };
  }
}

async function resolveRouteId(id: string): Promise<ResolvedId | null> {
  try {
    const res = await fetch(`/api/resolve?id=${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return await res.json() as ResolvedId;
  } catch {
    return null;
  }
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
  selectedHighlightId: string | null;

  // Addressable-URL state (see lib/layman-url.ts and hooks/useLaymanRoute.ts).
  // selectedTurnPromptEventId is what lets the outbound URL keep saying /t/<id>
  // after a deep link has been hydrated, instead of decaying to /s/<id>.
  selectedTurnPromptEventId: string | null;
  routeFolderId: string | null;
  routeHydrating: boolean;
  routeError: { message: string; instanceUrl: string } | null;
  /** Seeds the Sessions sidebar search — set by the route-error panel's search box. */
  sessionsSearchSeed: string | null;

  // Flowchart view
  flowchartOpen: boolean;

  // Dashboard view
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

  // Expanding-interface layout: each independently defaults to width-driven
  // auto-disclosure (null), or can be explicitly forced on/off by the user
  // (clicking the Dashboard/Logs tab, or jumping from a Dashboard row into Logs).
  dashboardOverride: boolean | null;
  logsOverride: boolean | null;
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
  setSelectedHighlight: (highlightId: string | null) => void;
  selectTurn: (sessionId: string, promptEventId: string | null) => void;
  hydrateFromRoute: (route: LaymanRoute, opts: RouteOptions) => Promise<void>;
  clearRouteError: () => void;
  setSessionsSearchSeed: (query: string | null) => void;
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

  toggleDashboardVisible: () => void;
  toggleLogsVisible: () => void;
  activateOnlyLiveTab: (tab: 'dashboard' | 'stream') => void;
  setSplitOverride: (key: keyof SplitOverrides, value: number) => void;
  resetSplitOverrides: () => void;
  setPanelLayout: (layout: PanelLayout) => void;
  toggleLogHighlight: (eventId: string) => void;
  setExpandedLogEventIds: (ids: Set<string> | 'all') => void;
  toggleExpandAllLogs: (detailEventIds: string[]) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
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
  selectedHighlightId: null,

  selectedTurnPromptEventId: null,
  routeFolderId: null,
  routeHydrating: false,
  routeError: null,
  sessionsSearchSeed: null,

  flowchartOpen: false,

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

  dashboardOverride: null,
  logsOverride: null,
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
    set((state) => {
      const updated = state.bookmarks.map((b) =>
        b.folderId === folderId ? { ...b, folderId: null } : b
      );
      return {
        bookmarkFolders: state.bookmarkFolders.filter((f) => f.id !== folderId),
        bookmarks: updated,
      };
    }),

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
    selectedTurnPromptEventId: promptEventId,
  }),

  setSelectedHighlight: (selectedHighlightId) => set({ selectedHighlightId }),

  // An explicit user navigation to one turn — the URL becomes /s/<sid>/t/<pid>.
  selectTurn: (sessionId, promptEventId) => set({
    viewMode: 'sessions',
    ...viewModeFlags('sessions'),
    viewingSessionId: sessionId,
    selectedTurnPromptEventId: promptEventId,
    ...(promptEventId ? { bookmarksScrollToEventId: promptEventId } : {}),
  }),

  clearRouteError: () => set({ routeError: null }),

  setSessionsSearchSeed: (sessionsSearchSeed) => set({ sessionsSearchSeed }),

  /**
   * Applies a parsed URL to the store — the inbound half of useLaymanRoute.
   *
   * Deliberately the only place a route turns into view state: the outbound half
   * derives a URL from these same fields, so anything set here must also be
   * readable back out or a deep link decays on the first re-render.
   */
  hydrateFromRoute: async (route, opts) => {
    const instanceUrl = instanceUrlOf(get().config);
    const fail = (message: string) =>
      set({ routeError: { message, instanceUrl }, routeHydrating: false });
    const done = (patch: Partial<SessionState>) =>
      set({ ...patch, routeHydrating: false, routeError: null });

    set({ routeHydrating: true, routeError: null });

    /** Opens a session's transcript, optionally focused on one turn or event. */
    const openSession = async (
      sessionId: string,
      focus: { promptEventId?: string; eventId?: string },
    ): Promise<void> => {
      const { events: recorded, metrics } = await fetchSessionEvents(sessionId);
      // A live session with sessionRecording off exists only in memory.
      const events = recorded.length > 0
        ? recorded
        : get().events.filter((e) => e.sessionId === sessionId);

      if (events.length === 0) {
        fail(`No session ${sessionId.slice(0, 8)} on this instance.`);
        return;
      }

      const mode = opts.view ? viewModeForName(opts.view) : 'sessions';
      const base: Partial<SessionState> = {
        historicalEvents: events,
        sessionTimeMetrics: metrics,
        activeSessionId: sessionId,
      };

      // Logs and Flow render the live store keyed by activeSessionId; only the
      // Sessions transcript reads historicalEvents.
      if (mode === 'stream' || mode === 'flowchart') {
        done({
          ...base,
          viewMode: mode,
          ...viewModeFlags(mode),
          viewingSessionId: null,
          scrollToEventId: focus.eventId ?? focus.promptEventId ?? null,
          ...(mode === 'stream'
            ? { logsOverride: true, dashboardOverride: false, splitOverrides: {} }
            : {}),
        });
        return;
      }

      let turnPromptEventId: string | null = null;
      let expanded = get().expandedLogEventIds;

      if (focus.promptEventId) {
        const turn = extractTurn(events, focus.promptEventId);
        if (!turn) {
          fail(`Turn ${focus.promptEventId.slice(0, 8)} is not in session ${sessionId.slice(0, 8)}.`);
          return;
        }
        // The addressed id may be a collapsed duplicate; the turn names the survivor.
        turnPromptEventId = turn.promptEventId;
        if (expanded !== 'all') {
          expanded = new Set([...expanded, ...pairFor(turn.promptEventId, events)]);
        }
      } else if (focus.eventId && !events.some((e) => e.id === focus.eventId)) {
        fail(`Event ${focus.eventId.slice(0, 8)} is not in session ${sessionId.slice(0, 8)}.`);
        return;
      }

      done({
        ...base,
        viewMode: 'sessions',
        ...viewModeFlags('sessions'),
        viewingSessionId: sessionId,
        selectedTurnPromptEventId: turnPromptEventId,
        bookmarksScrollToEventId: focus.eventId ?? turnPromptEventId,
        expandedLogEventIds: expanded,
      });
    };

    switch (route.kind) {
      case 'dashboard': {
        const mode = opts.view ? viewModeForName(opts.view) : 'dashboard';
        done({
          viewMode: mode,
          ...viewModeFlags(mode),
          ...(mode === 'dashboard' ? { dashboardOverride: true, logsOverride: false, splitOverrides: {} } : {}),
          ...(mode === 'stream' ? { logsOverride: true, dashboardOverride: false, splitOverrides: {} } : {}),
        });
        return;
      }

      case 'session':
        await openSession(route.sessionId, {});
        return;

      case 'turn':
        await openSession(route.sessionId, { promptEventId: route.promptEventId });
        return;

      case 'event':
        await openSession(route.sessionId, { eventId: route.eventId });
        return;

      case 'highlight': {
        const resolved = await resolveRouteId(route.highlightId);
        if (!resolved || resolved.kind !== 'highlight') {
          fail(`No highlight ${route.highlightId.slice(0, 8)} on this instance.`);
          return;
        }
        // An explicit non-Prompts ?view opens the underlying turn instead of the card.
        if (opts.view && opts.view !== 'prompts' && resolved.sessionId) {
          await openSession(resolved.sessionId, { promptEventId: resolved.promptEventId });
          return;
        }
        done({
          viewMode: 'prompts',
          ...viewModeFlags('prompts'),
          selectedHighlightId: resolved.id,
        });
        return;
      }

      case 'bookmark': {
        const resolved = await resolveRouteId(route.bookmarkId);
        if (!resolved || resolved.kind !== 'bookmark' || !resolved.sessionId) {
          fail(`No bookmark ${route.bookmarkId.slice(0, 8)} on this instance.`);
          return;
        }
        await openSession(resolved.sessionId, {});
        return;
      }

      case 'folder': {
        const resolved = await resolveRouteId(route.folderId);
        if (!resolved || (resolved.kind !== 'folder' && resolved.kind !== 'highlight_folder')) {
          fail(`No folder ${route.folderId.slice(0, 8)} on this instance.`);
          return;
        }
        // Both folder kinds share the /f/ prefix; the resolver says which view owns it.
        const mode = resolved.kind === 'highlight_folder' ? 'prompts' : 'sessions';
        done({
          viewMode: mode,
          ...viewModeFlags(mode),
          routeFolderId: resolved.id,
          viewingSessionId: null,
        });
        return;
      }
    }
  },

  setViewingSession: (viewingSessionId) =>
    set((state) => ({
      viewingSessionId,
      historicalEvents: viewingSessionId === null ? [] : state.historicalEvents,
      sessionTimeMetrics: viewingSessionId === null ? null : state.sessionTimeMetrics,
      // A turn address only means something within the session it came from.
      selectedTurnPromptEventId:
        viewingSessionId === state.viewingSessionId ? state.selectedTurnPromptEventId : null,
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
  // Clicking a Dashboard row opens that entry in Logs (not Investigation — the
  // user opens Investigation explicitly via the row's Investigate button).
  // Keeps Dashboard visible alongside Logs if there's room for both; otherwise
  // switches to a Logs-only view so the entry is never obscured.
  navigateFromDashboardToLogs: (sessionId, eventId) =>
    set((state) => {
      const bothFit = state.panelLayout.viewportWidth >= state.panelLayout.logsDockThreshold;
      return {
        viewMode: 'stream',
        ...viewModeFlags('stream'),
        returnToDashboard: !bothFit,
        activeSessionId: sessionId,
        scrollToEventId: eventId,
        dashboardOverride: bothFit,
        logsOverride: true,
        splitOverrides: {},
      };
    }),
  navigateToLogsForSession: (sessionId) =>
    set((state) => {
      const bothFit = state.panelLayout.viewportWidth >= state.panelLayout.logsDockThreshold;
      return {
        viewMode: 'stream',
        ...viewModeFlags('stream'),
        returnToDashboard: !bothFit,
        activeSessionId: sessionId,
        selectedEventId: null,
        investigationOpen: false,
        scrollToEventId: null,
        dashboardOverride: bothFit,
        logsOverride: true,
        splitOverrides: {},
      };
    }),
  clearScrollToEvent: () => set({ scrollToEventId: null }),
  returnFromDashboardDrilldown: () => set({
    viewMode: 'dashboard',
    ...viewModeFlags('dashboard'),
    returnToDashboard: false,
    investigationOpen: false,
    selectedEventId: null,
    dashboardOverride: true,
    logsOverride: false,
    splitOverrides: {},
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

  // Clicking Dashboard or Logs while it's already the active tab expands/collapses
  // the *other* panel (active → both shown, both shown → back to just this one).
  // Clicking the inactive tab always activates it exclusively, closing the other.
  toggleDashboardVisible: () =>
    set((state) => {
      const { showDashboard, showLogs } = state.panelLayout;
      if (showDashboard) {
        return { dashboardOverride: true, logsOverride: !showLogs, splitOverrides: {} };
      }
      return { dashboardOverride: true, logsOverride: false, splitOverrides: {} };
    }),

  toggleLogsVisible: () =>
    set((state) => {
      const { showDashboard, showLogs } = state.panelLayout;
      if (showLogs) {
        return { logsOverride: true, dashboardOverride: !showDashboard, splitOverrides: {} };
      }
      return { logsOverride: true, dashboardOverride: false, splitOverrides: {} };
    }),

  // Used when arriving at the live Dashboard/Logs view from an exclusive
  // full-page view (Flow, Sessions, Prompts) — shows only the clicked tab,
  // regardless of whatever visibility state was in effect before navigating away.
  activateOnlyLiveTab: (tab) =>
    set({
      dashboardOverride: tab === 'dashboard',
      logsOverride: tab === 'stream',
      splitOverrides: {},
    }),

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
