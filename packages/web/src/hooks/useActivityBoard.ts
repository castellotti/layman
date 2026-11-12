import { useEffect, useMemo, useState } from 'react';
import { shallow } from 'zustand/shallow';
import { fetchRecordedSessionEvents, useSessionStore } from '../stores/sessionStore.js';
import { mergeSessionEvents, reduceBoard, type Board } from '../lib/activity-board.js';
import type { TimelineEvent } from '../lib/types.js';
import { useStationSetup } from './useStationSetup.js';

const NONE: TimelineEvent[] = [];

/**
 * Every event of one session: its recording (fetched from SQLite once per session, since the live
 * store holds at most 10,000 events of all sessions and the WebSocket replays only the last 100)
 * joined with the live events that arrived since. Re-renders only when this session's events change.
 */
export function useSessionTimeline(sessionId: string | null): { events: TimelineEvent[]; loading: boolean } {
  const [recorded, setRecorded] = useState<{ sessionId: string; events: TimelineEvent[] } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void fetchRecordedSessionEvents(sessionId).then((events) => {
      if (!cancelled) setRecorded({ sessionId, events });
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  const live = useSessionStore(
    (s) => (sessionId ? s.events.filter((e) => e.sessionId === sessionId) : NONE),
    shallow,
  );
  const ours = recorded && recorded.sessionId === sessionId ? recorded.events : null;
  const events = useMemo(() => mergeSessionEvents(ours ?? NONE, live), [ours, live]);
  return { events, loading: sessionId !== null && ours === null };
}

/** One session's activity board, recomputed when its events or the Memory settings change. */
export function useActivityBoard(sessionId: string | null, ended: boolean): { board: Board; loading: boolean } {
  const { events, loading } = useSessionTimeline(sessionId);
  const setup = useStationSetup();
  const board = useMemo(() => reduceBoard(events, { setup, ended }), [events, setup, ended]);
  return { board, loading };
}
