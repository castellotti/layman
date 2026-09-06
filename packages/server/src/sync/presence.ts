import type { TimelineEvent, EventData } from '../events/types.js';
import type { SessionInfo } from '../events/store.js';
import type { PushBatch, PresencePayload, WireRow } from './protocol.js';

/** Live-tail window: only events this recent are surfaced on the dashboard. */
const LIVE_TAIL_WINDOW_MS = 10 * 60 * 1000;
/** Per-session ring size for the connect replay. */
const RING_SIZE = 50;
/** Presence TTL falls back to this multiple of the remote's reported interval. */
const TTL_INTERVAL_MULTIPLIER = 3;
const DEFAULT_INTERVAL_SECONDS = 5;

interface HostPresence {
  hostId: string;
  hostName: string;
  intervalSeconds: number;
  lastPushAt: number;
  activeSessionIds: Set<string>;
  sessions: Map<string, PresenceSessionState>;
}

interface PresenceSessionState {
  cwd: string;
  agentType: string;
  sessionName?: string;
  lastSeen: number;
  ring: TimelineEvent[];
}

/** Convert an event wire row (JSON blobs as strings) to a TimelineEvent. */
export function wireRowToEvent(row: WireRow): TimelineEvent {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    type: String(row.type) as TimelineEvent['type'],
    timestamp: Number(row.timestamp),
    agentType: String(row.agent_type),
    data: (row.data_json ? JSON.parse(String(row.data_json)) : {}) as EventData,
    analysis: row.analysis_json ? JSON.parse(String(row.analysis_json)) : undefined,
    laymans: row.laymans_json ? JSON.parse(String(row.laymans_json)) : undefined,
    riskLevel: (row.risk_level as TimelineEvent['riskLevel']) ?? undefined,
  };
}

/**
 * Tracks live sessions reported by remote hosts (docs/planning/multi-host-sync.md
 * §3.8). Remote events never enter `EventStore`; this keeps just enough — the
 * active-session set per host and a small per-session event ring — to render a
 * remote session as running on the Dashboard, with its last few events, at no
 * cost to the local pipeline. A host whose presence has not refreshed within
 * 3× its interval is treated as idle.
 */
export class RemoteSessionRegistry {
  private hosts = new Map<string, HostPresence>();

  constructor(private now: () => number = Date.now) {}

  /**
   * Apply a push's presence + recent events. Returns the events that are new to
   * a ring (recent and belonging to an active remote session) so the caller can
   * broadcast them as `event:new`.
   */
  ingestPush(hostId: string, hostName: string, batch: PushBatch): TimelineEvent[] {
    const presence = batch.live;
    const host = this.ensureHost(hostId, hostName, presence);

    const emitted: TimelineEvent[] = [];
    if (presence) {
      const cutoff = this.now() - LIVE_TAIL_WINDOW_MS;
      for (const entry of batch.entries) {
        if (entry.op !== 'upsert' || entry.kind !== 'event') continue;
        const event = wireRowToEvent(entry.row);
        if (event.timestamp < cutoff) continue;                     // too old (e.g. backfill)
        if (!host.activeSessionIds.has(event.sessionId)) continue;  // not a live session
        const session = host.sessions.get(event.sessionId);
        if (!session) continue;
        if (session.ring.some((e) => e.id === event.id)) continue;  // dedupe
        session.ring.push(event);
        if (session.ring.length > RING_SIZE) session.ring.shift();
        emitted.push(event);
      }
    }
    return emitted;
  }

  private ensureHost(hostId: string, hostName: string, presence?: PresencePayload): HostPresence {
    let host = this.hosts.get(hostId);
    if (!host) {
      host = {
        hostId, hostName,
        intervalSeconds: DEFAULT_INTERVAL_SECONDS,
        lastPushAt: this.now(),
        activeSessionIds: new Set(),
        sessions: new Map(),
      };
      this.hosts.set(hostId, host);
    }
    host.hostName = hostName;
    host.lastPushAt = this.now();

    if (presence) {
      host.activeSessionIds = new Set(presence.activeSessionIds);
      for (const s of presence.sessions) {
        const existing = host.sessions.get(s.sessionId);
        host.sessions.set(s.sessionId, {
          cwd: s.cwd,
          agentType: s.agentType,
          sessionName: s.sessionName,
          lastSeen: s.lastSeen,
          ring: existing?.ring ?? [],
        });
      }
    }
    return host;
  }

  /** Called when a remote reports its push interval, to size the presence TTL. */
  setInterval(hostId: string, intervalSeconds: number): void {
    const host = this.hosts.get(hostId);
    if (host && intervalSeconds > 0) host.intervalSeconds = intervalSeconds;
  }

  private isFresh(host: HostPresence): boolean {
    const ttl = host.intervalSeconds * 1000 * TTL_INTERVAL_MULTIPLIER;
    return this.now() - host.lastPushAt <= ttl;
  }

  /** Remote sessions to merge into the sessions list (active flag from TTL). */
  list(): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const host of this.hosts.values()) {
      const fresh = this.isFresh(host);
      for (const [sessionId, s] of host.sessions) {
        out.push({
          sessionId,
          cwd: s.cwd,
          lastSeen: s.lastSeen,
          agentType: s.agentType,
          sessionName: s.sessionName,
          hostId: host.hostId,
          hostName: host.hostName,
          remote: true,
          active: fresh && host.activeSessionIds.has(sessionId),
        });
      }
    }
    return out.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** Every ring event for active remote sessions, for the WebSocket connect replay. */
  replayEvents(): TimelineEvent[] {
    const out: TimelineEvent[] = [];
    for (const host of this.hosts.values()) {
      if (!this.isFresh(host)) continue;
      for (const s of host.sessions.values()) out.push(...s.ring);
    }
    return out.sort((a, b) => a.timestamp - b.timestamp);
  }
}
