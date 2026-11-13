import { useEffect, useMemo, useRef, useState } from 'react';
import { shallow } from 'zustand/shallow';
import { fetchRecordedSessionEvents, useSessionStore, type SessionState } from '../stores/sessionStore.js';
import { reduceBoard, type Board } from '../lib/activity-board.js';
import { countPrompts, mergeRecordedWithLive } from '../lib/session-events.js';
import type { TimelineEvent } from '../lib/types.js';
import { useStationSetup } from './useStationSetup.js';

const NONE: TimelineEvent[] = [];

/** This session's live events, filtered again only when the store's event list changes. */
function useLiveEvents(sessionId: string | null): TimelineEvent[] {
  const memo = useRef<{ all: TimelineEvent[]; sessionId: string | null; ours: TimelineEvent[] } | null>(null);
  return useSessionStore((s: SessionState) => {
    const m = memo.current;
    if (m && m.all === s.events && m.sessionId === sessionId) return m.ours;
    const ours = sessionId ? s.events.filter((e) => e.sessionId === sessionId) : NONE;
    memo.current = { all: s.events, sessionId, ours };
    return ours;
  }, shallow);
}

/**
 * Every event of one session: its recording (fetched from SQLite, lean, since the live store holds at
 * most 10,000 events of all sessions and the WebSocket replays only the last 100) joined with the
 * live events, and with the late updates of recorded calls that finished since the fetch. A fetch
 * that failed, or found the session not recorded yet, is tried again at the session's next prompt.
 */
export function useSessionTimeline(sessionId: string | null): { events: TimelineEvent[]; loading: boolean } {
  const live = useLiveEvents(sessionId);
  const lateUpdates = useSessionStore((s) => s.lateUpdates);
  // A deep link has already loaded this session's whole recording (`hydrateFromRoute`); use it
  // rather than fetching it again. The store keeps it current with `event:update`s itself.
  const hydrated = useSessionStore((s) =>
    sessionId && s.historicalEvents.length > 0 && s.historicalEvents[0].sessionId === sessionId ? s.historicalEvents : null);
  const prompts = useMemo(() => countPrompts(live), [live]);
  const [recorded, setRecorded] = useState<{ sessionId: string; events: TimelineEvent[] | null } | null>(null);
  const ours = recorded && recorded.sessionId === sessionId ? recorded : null;
  const missing = ours !== null && ours.events === null;

  useEffect(() => {
    if (!sessionId || hydrated) return;
    let cancelled = false;
    void fetchRecordedSessionEvents(sessionId, { lean: true }).then((events) => {
      if (!cancelled) setRecorded({ sessionId, events });
    });
    return () => { cancelled = true; };
    // `prompts` only while the recording is missing: a retry, never a refresh of one we have.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, hydrated !== null, missing ? prompts : -1]);

  const base = hydrated ?? ours?.events ?? NONE;
  const patched = useMemo(() => {
    // The hydrated recording is in the store, which applies updates to it already.
    if (hydrated || lateUpdates.size === 0 || base.length === 0) return base;
    let changed = false;
    const out = base.map((e) => {
      const u = lateUpdates.get(e.id);
      if (!u) return e;
      changed = true;
      return { ...e, ...u, data: { ...e.data, ...u.data } };
    });
    return changed ? out : base;
  }, [base, hydrated, lateUpdates]);
  const events = useMemo(() => mergeRecordedWithLive(patched, live), [patched, live]);
  return { events, loading: sessionId !== null && !hydrated && ours === null };
}

/** One session's activity board, recomputed when its events or the Memory settings change. */
export function useActivityBoard(sessionId: string | null, ended: boolean): { board: Board; events: TimelineEvent[]; loading: boolean } {
  const { events, loading } = useSessionTimeline(sessionId);
  const setup = useStationSetup();
  const board = useMemo(() => reduceBoard(events, { setup, ended }), [events, setup, ended]);
  return { board, events, loading };
}
