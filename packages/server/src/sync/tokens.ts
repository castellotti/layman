import { randomBytes, createHash } from 'crypto';
import type { Database } from '../db/database.js';
import type { PeerDTO } from './protocol.js';

/** A per-host bearer token: `lmk_` + 32 random bytes, base64url. Shown once. */
export function generateToken(): string {
  return 'lmk_' + randomBytes(32).toString('base64url');
}

/** Only the hash is stored; the plaintext token never touches the database. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface RawPeer {
  token_hash: string;
  name: string;
  host_id: string | null;
  created_at: number;
  last_seen_at: number | null;
  last_push_seq: number | null;
  last_pull_seq: number | null;
  interval_seconds: number | null;
  revoked_at: number | null;
  last_error: string | null;
}

export function peerToDTO(p: RawPeer): PeerDTO {
  return {
    tokenHash: p.token_hash,
    name: p.name,
    hostId: p.host_id,
    createdAt: p.created_at,
    lastSeenAt: p.last_seen_at,
    lastPushSeq: p.last_push_seq,
    lastPullSeq: p.last_pull_seq,
    intervalSeconds: p.interval_seconds,
    revokedAt: p.revoked_at,
    lastError: p.last_error,
  };
}

/**
 * Manages issued sync tokens on a central (docs/planning/multi-host-sync.md §3.7).
 * Enrolment is trust-on-first-use: a token binds to the first host id that
 * presents it, and any later hello with a different host id is rejected.
 */
export class PeerStore {
  constructor(private db: Database) {}

  /** Issue a token for a named remote. Returns the plaintext once. */
  create(name: string): { token: string; peer: PeerDTO } {
    const token = generateToken();
    const hash = hashToken(token);
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sync_peers (token_hash, name, created_at) VALUES (?, ?, ?)')
      .run(hash, name, now);
    return { token, peer: peerToDTO(this.byHash(hash)!) };
  }

  byHash(hash: string): RawPeer | null {
    return (this.db.prepare('SELECT * FROM sync_peers WHERE token_hash = ?').get(hash) as RawPeer | undefined) ?? null;
  }

  /** Look up an active (non-revoked) peer by presented plaintext token. */
  authenticate(token: string): RawPeer | null {
    const peer = this.byHash(hashToken(token));
    if (!peer || peer.revoked_at) return null;
    return peer;
  }

  /** Bind a peer's host id on first hello; returns false on a mismatched rebind. */
  bindHost(hash: string, hostId: string): boolean {
    const peer = this.byHash(hash);
    if (!peer) return false;
    if (peer.host_id && peer.host_id !== hostId) return false;
    if (!peer.host_id) {
      this.db.prepare('UPDATE sync_peers SET host_id = ? WHERE token_hash = ?').run(hostId, hash);
    }
    return true;
  }

  touch(hash: string, fields: Partial<{ lastSeenAt: number; intervalSeconds: number; lastPushSeq: number; lastPullSeq: number; lastError: string | null }>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.lastSeenAt !== undefined) { sets.push('last_seen_at = ?'); vals.push(fields.lastSeenAt); }
    if (fields.intervalSeconds !== undefined) { sets.push('interval_seconds = ?'); vals.push(fields.intervalSeconds); }
    if (fields.lastPushSeq !== undefined) { sets.push('last_push_seq = ?'); vals.push(fields.lastPushSeq); }
    if (fields.lastPullSeq !== undefined) { sets.push('last_pull_seq = ?'); vals.push(fields.lastPullSeq); }
    if (fields.lastError !== undefined) { sets.push('last_error = ?'); vals.push(fields.lastError); }
    if (sets.length === 0) return;
    vals.push(hash);
    this.db.prepare(`UPDATE sync_peers SET ${sets.join(', ')} WHERE token_hash = ?`).run(...vals);
  }

  revoke(hash: string): void {
    this.db.prepare('UPDATE sync_peers SET revoked_at = ? WHERE token_hash = ?').run(Date.now(), hash);
  }

  remove(hash: string): void {
    this.db.prepare('DELETE FROM sync_peers WHERE token_hash = ?').run(hash);
  }

  list(): PeerDTO[] {
    const rows = this.db.prepare('SELECT * FROM sync_peers ORDER BY created_at ASC').all() as RawPeer[];
    return rows.map(peerToDTO);
  }
}
