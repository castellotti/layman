import { useEffect, useMemo, useRef, useState } from 'react';
import { shallow } from 'zustand/shallow';
import { fetchRecordedSessionEvents, useSessionStore, type SessionState } from '../stores/sessionStore.js';
import { reduceBoard, type Board } from '../lib/activity-board.js';
import { countPrompts, mergeRecordedWithLive } from '../lib/session-events.js';
import type { TimelineEvent } from '../lib/types.js';
import { useStationSetup } from './useStationSetup.js';

const NONE: TimelineEvent[] = [];

/**
 * The last lean recordings fetched, by session, so a map that re-mounts (a Dashboard pane's map
 * toggled, the Activity tab reopened) does not download a whole session again. The live events
 * joined to it cover what came after.
 */
const cache = new Map<string, TimelineEvent[]>();
/** Few: a long session's recording is tens of megabytes in memory. */
const CACHED_SESSIONS = 4;
function remember(sessionId: string, events: TimelineEvent[]): void {
  cache.delete(sessionId);
  cache.set(sessionId, events);
  if (cache.size > CACHED_SESSIONS) cache.delete(cache.keys().next().value as string);
}

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
export function useSessionTimeline(sessionId: string | null, liveEvents?: TimelineEvent[]): { events: TimelineEvent[]; loading: boolean } {
  // A Dashboard pane already holds its session's live events; filtering the store again per pane
  // would scan every event of every session once per pane, on each event.
  const own = useLiveEvents(liveEvents ? null : sessionId);
  const live = liveEvents ?? own;
  const lateUpdates = useSessionStore((s) => s.lateUpdates);
  // A deep link has already loaded this session's whole recording (`hydrateFromRoute`); use it
  // rather than fetching it again. The store keeps it current with `event:update`s itself.
  const hydrated = useSessionStore((s) =>
    sessionId && s.historicalEvents.length > 0 && s.historicalEvents[0].sessionId === sessionId ? s.historicalEvents : null);
  const prompts = useMemo(() => countPrompts(live), [live]);
  const [recorded, setRecorded] = useState<{ sessionId: string; events: TimelineEvent[] | null } | null>(
    () => (sessionId && cache.has(sessionId) ? { sessionId, events: cache.get(sessionId)! } : null));
  const ours = recorded && recorded.sessionId === sessionId ? recorded : null;
  const missing = ours !== null && ours.events === null;
  // The live slice no longer reaches back to the recording: the store dropped this session's older
  // live events (it holds 10,000 of all sessions'), so what came between is in neither. Fetch again.
  const gap = useMemo(() => {
    const rec = ours?.events;
    if (!rec || rec.length === 0 || live.length === 0) return false;
    let newest = 0;
    for (const e of rec) if (e.timestamp > newest) newest = e.timestamp;
    let oldest = Infinity;
    for (const e of live) if (e.timestamp < oldest) oldest = e.timestamp;
    return oldest > newest;
  }, [ours, live]);
  const cached = ours !== null && !missing && !gap;

  useEffect(() => {
    // Once the store holds the whole recording, drop the lean copy rather than keep both.
    if (hydrated) { setRecorded(null); return; }
    if (!sessionId || cached) return;
    const kept = ours === null ? cache.get(sessionId) : undefined;
    if (kept) { setRecorded({ sessionId, events: kept }); return; }
    let cancelled = false;
    void fetchRecordedSessionEvents(sessionId, { lean: true }).then((events) => {
      if (cancelled) return;
      if (events) remember(sessionId, events);
      setRecorded({ sessionId, events });
    });
    return () => { cancelled = true; };
    // Fetched once per session (or taken from the cache), and again at a prompt only while the
    // recording is missing or the live slice has a gap after it: a retry, never a routine refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, hydrated !== null, cached ? -1 : prompts]);

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
export function useActivityBoard(sessionId: string | null, ended: boolean, liveEvents?: TimelineEvent[]): { board: Board; events: TimelineEvent[]; loading: boolean } {
  const { events, loading } = useSessionTimeline(sessionId, liveEvents);
  const setup = useStationSetup();
  const board = useMemo(() => reduceBoard(events, { setup, ended }), [events, setup, ended]);
  return { board, events, loading };
}
