/**
 * A glove session's LLM tokens over a time range, for Topology's Selected path
 * (`GET /api/net/sessions/:token/tokens`). Read from the pi transcripts the
 * session's observe grant exports, the same files `PiSessionWatcher` tails, through
 * the same roots (`GloveSource`): no new path, nothing written, no network.
 *
 * Every billed call (`piUsageSamples`: assistant messages and compactions, on every
 * branch) is summed by its entry's time, so a range counts the calls that finished
 * in it, the way SENT/RECEIVED count the bytes that moved in it. All records is
 * every call in every file.
 *
 * pi only appends, so each file is read once and then from where the last read
 * stopped; a file that shrank or was replaced is read again from the start.
 */
import { closeSync, fstatSync, openSync, readSync } from 'fs';
import { sep } from 'path';
import type { WatchRoot } from '../monitor/sources.js';
import type { NetRange } from '../netobs/types.js';
import { splitLines } from '../netobs/tail.js';
import { addTokens, discoverPiSessionsUnder, piUsageSamples, zeroTokens, type PiTokens } from '../hooks/transcript-pi.js';

/** The token kinds a provider may leave out: 0 on every call means "not reported", not "none". */
const OPTIONAL_KINDS = ['cacheRead', 'cacheWrite', 'reasoning'] as const;
type OptionalKind = (typeof OPTIONAL_KINDS)[number];

export interface TokenSums {
  tokens: PiTokens;
  /** Billed calls counted. Zero means nothing to show. */
  calls: number;
  /**
   * The optional kinds some call of the session reported (non-zero), over all records whatever the
   * range: pi-ai records 0 for a kind the provider's API does not send (cache write on
   * openai-completions without `cache_write_tokens`, on openai-responses and Mistral; thinking
   * without `reasoning_tokens`), so a kind never seen is unknown and the client hides it.
   */
  reported: OptionalKind[];
}

interface FileState {
  /** Bytes read so far. */
  offset: number;
  /** The unfinished last line read, completed by the next read. */
  partial: Buffer;
  /** Identity of the file read, so a replaced file is read again. */
  ino: number;
  samples: Array<{ at: number; tokens: PiTokens }>;
}

export class PiUsageReader {
  private files = new Map<string, FileState>();

  /** @param roots the pi watch roots of glove sessions; each root's `label` is its session id. */
  constructor(private readonly roots: () => WatchRoot[]) {}

  /** The session's token sums in the range (all of them when null), or null when it has no pi transcripts. */
  sum(token: string, range: NetRange | null, now = Date.now()): TokenSums | null {
    const root = this.roots().find((r) => r.agentType === 'pi' && r.label === token);
    if (!root) return null;
    const to = range?.to ?? now;
    const tokens = zeroTokens();
    let calls = 0;
    const seen = new Set<OptionalKind>();
    const files = discoverPiSessionsUnder(root.path).map((d) => d.path);
    // Forget files that are gone, so a long-running server does not keep their samples.
    const listed = new Set(files);
    for (const path of this.files.keys()) if (path.startsWith(root.path + sep) && !listed.has(path)) this.files.delete(path);
    for (const file of files) {
      for (const s of this.samples(file)) {
        for (const k of OPTIONAL_KINDS) if (s.tokens[k] > 0) seen.add(k);
        if (range && (s.at < range.from || s.at > to)) continue;
        addTokens(tokens, s.tokens);
        calls++;
      }
    }
    return { tokens, calls, reported: OPTIONAL_KINDS.filter((k) => seen.has(k)) };
  }

  private samples(path: string): FileState['samples'] {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      this.files.delete(path);
      return [];
    }
    try {
      const st = fstatSync(fd);
      let state = this.files.get(path);
      if (!state || state.ino !== st.ino || st.size < state.offset) {
        state = { offset: 0, partial: Buffer.alloc(0), ino: st.ino, samples: [] };
        this.files.set(path, state);
      }
      // The whole unread part: a transcript line (a large tool result) can be megabytes long.
      const length = st.size - state.offset;
      if (length <= 0) return state.samples;
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, state.offset);
      // Only whole lines: a line pi is still writing is kept and finished next time.
      const lines: string[] = [];
      state.partial = splitLines(state.partial, buf.subarray(0, read), lines);
      state.offset += read;
      state.samples.push(...piUsageSamples(lines));
      return state.samples;
    } catch {
      return this.files.get(path)?.samples ?? [];
    } finally {
      closeSync(fd);
    }
  }
}
