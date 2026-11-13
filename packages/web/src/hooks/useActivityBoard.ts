import { useEffect, useMemo, useState } from 'react';
import { shallow } from 'zustand/shallow';
import { fetchRecordedSessionEvents, useSessionStore, type SessionState } from '../stores/sessionStore.js';
import { reduceBoard, type Board } from '../lib/activity-board.js';
import { countPrompts, mergeRecordedWithLive } from '../lib/session-events.js';
import type { TimelineEvent } from '../lib/types.js';
import { useStationSetup } from './useStationSetup.js';

const NONE: TimelineEvent[] = [];

/**
 * The last lean recordings fetched, by session, so reopening the Activity tab does not download a
 * whole session again. The live events joined to it cover what came after.
 */
const cache = new Map<string, TimelineEvent[]>();
/** Two (the session mapped and the one before it): a long session's recording is tens of megabytes in memory. */
const CACHED_SESSIONS = 2;
function remember(sessionId: string, events: TimelineEvent[]): void {
  cache.delete(sessionId);
  cache.set(sessionId, events);
  if (cache.size > CACHED_SESSIONS) cache.delete(cache.keys().next().value as string);
}

/**
 * The store's events split by session, once per event list, not at every store change the selector
 * runs on. Weak, so a replaced list's split goes with it.
 */
const splits = new WeakMap<TimelineEvent[], Map<string, TimelineEvent[]>>();
function bySession(all: TimelineEvent[]): Map<string, TimelineEvent[]> {
  let split = splits.get(all);
  if (!split) {
    split = new Map();
    for (const e of all) {
      const list = split.get(e.sessionId);
      if (list) list.push(e); else split.set(e.sessionId, [e]);
    }
    splits.set(all, split);
  }
  return split;
}

/** This session's live events; `shallow` keeps the same array while another session's arrive. */
function useLiveEvents(sessionId: string | null): TimelineEvent[] {
  return useSessionStore((s: SessionState) => (sessionId ? bySession(s.events).get(sessionId) ?? NONE : NONE), shallow);
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
  // This session's fetch, or else a recording an earlier map of it fetched.
  const ours = useMemo(() => {
    if (recorded && recorded.sessionId === sessionId) return recorded;
    const kept = sessionId ? cache.get(sessionId) : undefined;
    return sessionId && kept ? { sessionId, events: kept } : null;
  }, [recorded, sessionId]);
  const missing = ours !== null && ours.events === null;
  // The live slice no longer reaches back to the recording: the store dropped this session's older
  // live events (it holds 10,000 of all sessions'), so what came between is in neither. Fetch again.
  // The recording's newest time is scanned once per fetch, not again at every live event.
  const recordedUntil = useMemo(() => {
    let newest = -Infinity;
    for (const e of ours?.events ?? NONE) if (e.timestamp > newest) newest = e.timestamp;
    return newest;
  }, [ours]);
  const gap = useMemo(() => {
    if (recordedUntil === -Infinity || live.length === 0) return false;
    let oldest = Infinity;
    for (const e of live) if (e.timestamp < oldest) oldest = e.timestamp;
    return oldest > recordedUntil;
  }, [recordedUntil, live]);
  const cached = ours !== null && !missing && !gap;

  useEffect(() => {
    // Once the store holds the whole recording, drop the lean copy rather than keep both.
    if (hydrated) { setRecorded(null); return; }
    if (!sessionId) return;
    // A hit counts as a use, so the cache drops the session least recently mapped.
    if (cached) { if (ours.events) remember(sessionId, ours.events); return; }
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
export function useActivityBoard(sessionId: string | null, ended: boolean): { board: Board; events: TimelineEvent[]; loading: boolean } {
  const { events, loading } = useSessionTimeline(sessionId);
  const setup = useStationSetup();
  const board = useMemo(() => reduceBoard(events, { setup, ended }), [events, setup, ended]);
  return { board, events, loading };
}
