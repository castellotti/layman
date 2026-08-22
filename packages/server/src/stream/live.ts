import { EventEmitter } from 'events';

/**
 * Partial assistant output, as it is generated.
 *
 * This is deliberately *not* an `EventStore` event. Everything added via
 * `EventStore.add()` is PII-scanned, pushed onto a 10,000-entry ring, recorded
 * into SQLite and broadcast — which is right for a tool call and ruinous for a
 * token delta, of which a local model produces thousands per turn. The
 * `session_metrics` map is the precedent: high-frequency data gets a dedicated
 * store and a dedicated WebSocket message, never the timeline.
 */
export interface LiveStream {
  sessionId: string;
  agentType: string;
  messageId: string;
  phase: 'thinking' | 'text' | 'idle';
  /** Accumulated, tail-truncated to MAX_BUFFER_CHARS. */
  thinking: string;
  /** Accumulated, tail-truncated to MAX_BUFFER_CHARS. */
  text: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /**
   * `tokens.output` is derived from the accumulated text rather than reported.
   *
   * No harness reports usage *during* generation — pi and OpenCode both attach
   * it to the finished message, by which point the live row is already gone — so
   * a counter that only ever showed reported values would read 0 for its entire
   * lifetime. The UI renders the approximation with a `~`; a producer that does
   * send `tokens` supersedes it and clears this flag.
   */
  tokensEstimated?: boolean;
  model?: string;
  startedAt: number;
  updatedAt: number;
}

export interface StreamDelta {
  sessionId: string;
  agentType: string;
  messageId: string;
  /** Monotonic per message. Used to drop duplicated and out-of-order posts. */
  seq?: number;
  textDelta?: string;
  thinkingDelta?: string;
  tokens?: Partial<LiveStream['tokens']>;
  model?: string;
  done?: boolean;
}

/**
 * An unbounded accumulator is a memory leak on a long agent monologue, and the
 * UI only ever shows the tail. 32 KB is far more than fits on screen and still
 * small enough that a hundred concurrent sessions are irrelevant.
 */
const MAX_BUFFER_CHARS = 32 * 1024;

/** A stream not updated within this window is presumed dead and swept. */
const IDLE_SWEEP_MS = 60_000;

const SWEEP_INTERVAL_MS = 10_000;

/**
 * Characters per token, for the live output estimate.
 *
 * The 4:1 rule of thumb every tokenizer's documentation quotes for English
 * prose. Running a real tokenizer over every delta would cost more than the
 * number is worth — this is a progress indicator, not an accounting figure, and
 * the exact usage lands with the committed message moments later.
 */
const CHARS_PER_TOKEN = 4;

/**
 * How long a finished message stays remembered, so a straggling delta cannot
 * reopen it. Matched to the idle sweep: past that window no live row survives
 * anyway, so there is nothing left to protect.
 */
const FINISHED_MEMORY_MS = IDLE_SWEEP_MS;

function tail(existing: string, addition: string): string {
  const combined = existing + addition;
  return combined.length <= MAX_BUFFER_CHARS
    ? combined
    : combined.slice(combined.length - MAX_BUFFER_CHARS);
}

export class LiveStreamStore extends EventEmitter {
  private streams = new Map<string, LiveStream>();
  /** Highest `seq` accepted per session, for ordering. */
  private lastSeq = new Map<string, number>();
  /**
   * The last message closed per session, and when.
   *
   * A producer's `done` flush and its final delta flush are independent posts
   * with no ordering guarantee between them: pi's `message_end` fires both
   * back to back. If `done` arrives first the stream is deleted, and without
   * this record the late delta would be treated as a brand-new message —
   * recreating the row and re-broadcasting `stream:update` after `stream:end`.
   * For a tool-call-only message no committed `agent_response` ever follows to
   * clear it, so the phantom row would sit there until the idle sweep.
   */
  private finished = new Map<string, { messageId: string; at: number }>();
  /** Output characters accumulated for the current message, pre-truncation. */
  private outputChars = new Map<string, number>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private stringFilter?: (text: string) => string;

  /**
   * Redaction applied to accumulated buffers.
   *
   * Deltas bypass the EventStore's PII filter entirely — the same class of hole
   * documented for `attachLaymans()` — so it has to be wired in here. It is
   * applied to the *accumulated buffer*, never to an individual delta: a
   * pattern like an API key or a JWT will routinely straddle a delta boundary,
   * and per-delta filtering would let both halves through untouched.
   */
  setStringFilter(filter: (text: string) => string): void {
    this.stringFilter = filter;
  }

  private redact(text: string): string {
    return this.stringFilter ? this.stringFilter(text) : text;
  }

  /**
   * Start sweeping idle streams. Not started in the constructor so tests and
   * short-lived CLI invocations do not leave a timer running.
   */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Never hold the process open for a housekeeping timer.
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  /**
   * Apply a delta, returning the updated stream — or null when the delta was
   * dropped as stale, or when it only closed an already-finished stream.
   */
  applyDelta(delta: StreamDelta, now = Date.now()): LiveStream | null {
    const existing = this.streams.get(delta.sessionId);

    // A message that has already been closed stays closed. Anything still
    // arriving for it is a delta that lost the race with its own `done`, and
    // reviving the row for it is worse than dropping the last few tokens.
    const closed = this.finished.get(delta.sessionId);
    if (closed && closed.messageId === delta.messageId) return null;

    // A new message supersedes whatever was streaming for this session: the
    // previous one either finished or was abandoned, and either way its partial
    // text must not be prepended to the new one.
    const isNewMessage = !existing || existing.messageId !== delta.messageId;

    if (!isNewMessage && delta.seq !== undefined) {
      const last = this.lastSeq.get(delta.sessionId);
      // `<=` drops duplicates as well as out-of-order arrivals. A retried POST
      // that got through the first time would otherwise double the text.
      if (last !== undefined && delta.seq <= last) return null;
    }

    const stream: LiveStream = isNewMessage
      ? {
          sessionId: delta.sessionId,
          agentType: delta.agentType,
          messageId: delta.messageId,
          phase: 'idle',
          thinking: '',
          text: '',
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          startedAt: now,
          updatedAt: now,
        }
      : { ...existing! };

    if (isNewMessage) {
      this.lastSeq.delete(delta.sessionId);
      this.outputChars.set(delta.sessionId, 0);
    }
    if (delta.seq !== undefined) this.lastSeq.set(delta.sessionId, delta.seq);

    let chars = this.outputChars.get(delta.sessionId) ?? 0;

    if (delta.thinkingDelta) {
      stream.thinking = this.redact(tail(stream.thinking, delta.thinkingDelta));
      stream.phase = 'thinking';
      chars += delta.thinkingDelta.length;
    }
    if (delta.textDelta) {
      stream.text = this.redact(tail(stream.text, delta.textDelta));
      stream.phase = 'text';
      chars += delta.textDelta.length;
    }
    this.outputChars.set(delta.sessionId, chars);

    if (delta.tokens) {
      stream.tokens = { ...stream.tokens, ...delta.tokens };
      // A reported figure always wins, and once one arrives the estimate is
      // never reinstated for this message.
      if (delta.tokens.output !== undefined) stream.tokensEstimated = false;
    }
    // Counted from the running character total rather than the buffers, which
    // are tail-truncated at 32 KB — a long monologue would otherwise appear to
    // stop generating once it hit the cap.
    if (stream.tokensEstimated !== false && chars > 0) {
      stream.tokens = { ...stream.tokens, output: Math.round(chars / CHARS_PER_TOKEN) };
      stream.tokensEstimated = true;
    }
    if (delta.model) stream.model = delta.model;
    stream.updatedAt = now;

    if (delta.done) {
      // Idempotent: a harness that closes a message it never streamed (a
      // tool-call-only assistant message, say) must not emit a spurious end.
      const existed = this.streams.delete(delta.sessionId);
      this.lastSeq.delete(delta.sessionId);
      this.outputChars.delete(delta.sessionId);
      this.finished.set(delta.sessionId, { messageId: delta.messageId, at: now });
      if (existed) this.emit('stream:end', delta.sessionId);
      return null;
    }

    this.streams.set(delta.sessionId, stream);
    this.emit('stream:update', stream);
    return stream;
  }

  /** End a session's stream, if it has one. Idempotent. */
  finish(sessionId: string, now = Date.now()): void {
    const stream = this.streams.get(sessionId);
    if (!this.streams.delete(sessionId)) return;
    this.lastSeq.delete(sessionId);
    this.outputChars.delete(sessionId);
    if (stream) this.finished.set(sessionId, { messageId: stream.messageId, at: now });
    this.emit('stream:end', sessionId);
  }

  get(sessionId: string): LiveStream | undefined {
    return this.streams.get(sessionId);
  }

  getAll(): LiveStream[] {
    return [...this.streams.values()];
  }

  /**
   * Drop streams whose harness stopped talking mid-generation. Without this a
   * crashed or Ctrl-C'd agent leaves a "typing" indicator on the dashboard
   * forever, which reads as Layman being broken rather than the agent being gone.
   */
  sweep(now = Date.now()): void {
    for (const [sessionId, stream] of this.streams) {
      if (now - stream.updatedAt > IDLE_SWEEP_MS) this.finish(sessionId, now);
    }
    // Closed-message records are only useful for as long as a straggling delta
    // could still arrive; keeping them past that is an unbounded map.
    for (const [sessionId, record] of this.finished) {
      if (now - record.at > FINISHED_MEMORY_MS) this.finished.delete(sessionId);
    }
  }
}
