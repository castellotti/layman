import { create } from 'zustand';
import type { TimelineEvent, RecordedSession } from '../lib/types.js';
import { useSessionStore } from './sessionStore.js';

// --- Types ---

export type SearchField =
  | 'dataPrompt'
  | 'dataToolName'
  | 'dataToolInput'
  | 'analysisMeaning'
  | 'laymansExplanation';

export type SearchScope = 'current' | 'all' | string; // string = specific sessionId

export interface SearchHistoryEntry {
  query: string;
  fields: SearchField[];
  scope: SearchScope;
  timestamp: number;
}

export interface SearchSessionSummary {
  sessionId: string;
  cwd: string;
  agentType: string;
  startedAt: number;
  lastSeen: number;
  matchCount: number;
}

export interface SearchResultEvent extends TimelineEvent {
  matchedFields: string[];
}

export interface SearchResultData {
  sessions: SearchSessionSummary[];
  events: SearchResultEvent[];
  totalMatches: number;
}

// --- Event Type Filter Categories ---

export interface EventTypeFilters {
  prompts: boolean;
  responses: boolean;
  responseFinalOnly: boolean;
  requests: boolean;
  questions: boolean;
  tools: boolean;
  laymans: boolean;
  analysis: boolean;
  risk: boolean;
  system: boolean;
}

export const DEFAULT_EVENT_TYPE_FILTERS: EventTypeFilters = {
  prompts: true,
  responses: true,
  responseFinalOnly: false,
  requests: true,
  questions: true,
  tools: true,
  laymans: true,
  analysis: true,
  risk: false,
  system: false,
};

export const EVENT_TYPE_CATEGORY_MAP: Record<string, (keyof EventTypeFilters)[]> = {
  user_prompt: ['prompts'],
  agent_response: ['responses'],
  permission_request: ['questions', 'requests'],
  elicitation: ['questions'],
  elicitation_result: ['questions'],
  tool_call_pending: ['questions'],
  tool_call_completed: ['tools'],
  tool_call_failed: ['tools'],
  tool_call_approved: ['tools'],
  tool_call_denied: ['tools'],
  tool_call_delegated: ['tools'],
  session_start: ['system'],
  session_end: ['system'],
  subagent_start: ['system'],
  subagent_stop: ['system'],
  notification: ['system'],
  pre_compact: ['system'],
  post_compact: ['system'],
  stop_failure: ['system'],
  agent_stop: ['system'],
  analysis_result: ['analysis'],
};

export function eventPassesFilters(event: TimelineEvent, filters: EventTypeFilters, allEvents?: TimelineEvent[]): boolean {
  // Risk filter: when enabled, only show medium/high risk events
  if (filters.risk) {
    if (event.riskLevel !== 'medium' && event.riskLevel !== 'high') return false;
  }

  const categories = EVENT_TYPE_CATEGORY_MAP[event.type];
  if (!categories) return true; // Unknown types pass through

  // Check if any category the event belongs to is enabled
  const categoryEnabled = categories.some((cat) => filters[cat]);
  if (!categoryEnabled) return false;

  // Special handling for "final only" responses
  if (event.type === 'agent_response' && filters.responseFinalOnly && allEvents) {
    const idx = allEvents.findIndex((e) => e.id === event.id);
    if (idx >= 0 && idx < allEvents.length - 1) {
      const next = allEvents[idx + 1];
      if (next.sessionId === event.sessionId &&
          next.type !== 'user_prompt' &&
          next.type !== 'session_end') {
        return false;
      }
    }
  }

  // Laymans/analysis filter: hide events that don't have the relevant data
  if (filters.laymans === false && event.laymans) {
    // The filter is off — this doesn't hide events, it's a category toggle
  }

  return true;
}

// --- localStorage Persistence ---

const HISTORY_STORAGE_KEY = 'layman:searchHistory';
const MAX_HISTORY = 50;

function loadHistory(): SearchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SearchHistoryEntry[];
  } catch {
    return [];
  }
}

function saveHistory(entries: SearchHistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore storage errors
  }
}

// --- Store ---

interface SearchState {
  query: string;
  fields: SearchField[];
  scope: SearchScope;
  advancedOpen: boolean;
  isSearching: boolean;
  searchResults: SearchResultData | null;
  searchError: string | null;
  searchHistory: SearchHistoryEntry[];
  eventTypeFilters: EventTypeFilters;

  // Actions
  setQuery: (query: string) => void;
  setFields: (fields: SearchField[]) => void;
  toggleField: (field: SearchField) => void;
  setScope: (scope: SearchScope) => void;
  setAdvancedOpen: (open: boolean) => void;
  setEventTypeFilters: (filters: Partial<EventTypeFilters>) => void;
  executeSearch: () => Promise<void>;
  clearSearch: () => void;
  clearHistory: () => void;
  restoreHistoryEntry: (entry: SearchHistoryEntry) => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  fields: ['dataPrompt', 'dataToolName', 'dataToolInput'],
  scope: 'all',
  advancedOpen: false,
  isSearching: false,
  searchResults: null,
  searchError: null,
  searchHistory: loadHistory(),
  eventTypeFilters: { ...DEFAULT_EVENT_TYPE_FILTERS },

  setQuery: (query) => set({ query }),
  setFields: (fields) => set({ fields }),

  toggleField: (field) =>
    set((state) => {
      const idx = state.fields.indexOf(field);
      if (idx >= 0) {
        return { fields: state.fields.filter((f) => f !== field) };
      }
      return { fields: [...state.fields, field] };
    }),

  setScope: (scope) => set({ scope }),
  setAdvancedOpen: (open) => set({ advancedOpen: open }),

  setEventTypeFilters: (partial) =>
    set((state) => ({
      eventTypeFilters: { ...state.eventTypeFilters, ...partial },
    })),

  executeSearch: async () => {
    const { query, fields, scope } = get();
    if (!query.trim()) return;

    set({ isSearching: true, searchError: null });

    // Resolve scope to sessionIds
    let sessionIds: string[] | undefined;
    if (scope === 'current') {
      const activeId = useSessionStore.getState().activeSessionId;
      if (activeId) sessionIds = [activeId];
    } else if (scope !== 'all') {
      sessionIds = [scope];
    }

    // Resolve event type filters to type list
    const { eventTypeFilters } = get();
    const eventTypes: string[] = [];
    for (const [eventType, categories] of Object.entries(EVENT_TYPE_CATEGORY_MAP)) {
      if (categories.some((cat) => eventTypeFilters[cat])) {
        eventTypes.push(eventType);
      }
    }

    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          fields,
          sessionIds,
          eventTypes: eventTypes.length > 0 ? eventTypes : undefined,
          limit: 200,
          offset: 0,
        }),
      });

      if (!res.ok) {
        const data = await res.json() as { error?: string };
        set({ isSearching: false, searchError: data.error ?? `HTTP ${res.status}` });
        return;
      }

      const results = await res.json() as SearchResultData;
      set({ isSearching: false, searchResults: results });

      // Add to history (deduplicate by query+scope)
      set((state) => {
        const entry: SearchHistoryEntry = { query, fields, scope, timestamp: Date.now() };
        const filtered = state.searchHistory.filter(
          (h) => !(h.query === query && h.scope === scope)
        );
        const newHistory = [entry, ...filtered].slice(0, MAX_HISTORY);
        saveHistory(newHistory);
        return { searchHistory: newHistory };
      });
    } catch (err) {
      set({
        isSearching: false,
        searchError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  clearSearch: () => set({ searchResults: null, searchError: null, query: '' }),

  clearHistory: () => {
    saveHistory([]);
    set({ searchHistory: [] });
  },

  restoreHistoryEntry: (entry) => {
    set({
      query: entry.query,
      fields: entry.fields,
      scope: entry.scope,
    });
  },
}));
