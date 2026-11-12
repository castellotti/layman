import type { TimelineEvent } from './types.js';

// ─── recorded-history merge ────────────────────────────────────────────────────
// The Dashboard is fed by the live EventStore, which holds only what the server
// has seen since it started. A *resumed* session — e.g. a glove pi run picked
// back up after an idle tombstone, or any session continued across a Layman
// restart — has its earlier turns only in SQLite: the passive watcher deliberately
// does NOT re-emit already-recorded history on resume (that would double-record it,
// since the live path mints fresh ids the recorder can't dedupe). So the live tail
// alone shows just "start" + the new turn, while the Sessions tab, which reads
// SQLite, shows the whole thread. This hook closes that gap for the preview: it
// fetches the session's recorded events once and merges them under the live tail,
// so the pane shows the full continued session and auto-scrolls to the latest.
//
// The merge dedupes by id (the live copy wins, so an in-place event:update is not
// lost) and then re-sorts by timestamp. The sort is not cosmetic: it must not
// assume the recorded slice is wholly older than the live-only slice. That holds
// for a resumed session (recorded = the earlier turns, live = the continuation),
// but *inverts* if recording is toggled on mid-session — then the recorded snapshot
// holds only the later turns while the earlier ones are live-only, and an
// append (recorded-then-live) would order them backwards, mis-numbering the #N
// badges. Sorting by timestamp is correct for both. Recording-off and brand-new
// sessions return no recorded rows and fall straight through to the live tail,
// unchanged. Skipped for remote (multi-host) sessions, whose live presence is
// deliberately a 10-minute window on central — backfilling their full history onto
// the Dashboard is out of scope here.
//
// Dedup is by id only, which is safe *because the passive watchers never re-emit
// already-recorded history on resume* (re-emitting would double-record it; the
// live path mints fresh randomUUIDs the recorder can't dedupe). That is a hard
// contract this merge depends on — a future harness that re-tails and re-posts
// earlier turns as fresh live events would give them ids that don't match the
// recorded rows and wall-clock timestamps far from the originals, so they would
// survive dedup and show twice. There is no safe content-level dedup here (it
// would drop legitimately-repeated tool calls), so the invariant must be upheld at
// the source, not patched over here.
export function mergeRecordedWithLive(
  recorded: TimelineEvent[],
  live: TimelineEvent[],
): TimelineEvent[] {
  if (recorded.length === 0) return live;
  const byId = new Map<string, TimelineEvent>();
  for (const e of recorded) byId.set(e.id, e);
  for (const e of live) byId.set(e.id, e); // live copy wins on id collision
  // Stable sort: equal-timestamp ties keep insertion order (recorded before
  // live-only), matching the natural chronology of a resumed session.
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
}
