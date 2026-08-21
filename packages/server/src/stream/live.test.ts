import { describe, it, expect, beforeEach } from 'vitest';
import { LiveStreamStore, type LiveStream, type StreamDelta } from './live.js';
import { filterPii } from '../pii/filter.js';

let store: LiveStreamStore;

const SESSION = 'sess-1';
const MESSAGE = 'msg-1';

function delta(extra: Partial<StreamDelta> = {}): StreamDelta {
  return { sessionId: SESSION, agentType: 'pi', messageId: MESSAGE, ...extra };
}

beforeEach(() => {
  store = new LiveStreamStore();
});

describe('accumulation', () => {
  it('appends text deltas in order', () => {
    store.applyDelta(delta({ seq: 0, textDelta: 'Hello' }));
    store.applyDelta(delta({ seq: 1, textDelta: ', ' }));
    const stream = store.applyDelta(delta({ seq: 2, textDelta: 'world' }));

    expect(stream?.text).toBe('Hello, world');
    expect(stream?.phase).toBe('text');
  });

  it('keeps thinking and text in separate buffers', () => {
    store.applyDelta(delta({ seq: 0, thinkingDelta: 'let me consider' }));
    const stream = store.applyDelta(delta({ seq: 1, textDelta: 'the answer is 4' }));

    expect(stream?.thinking).toBe('let me consider');
    expect(stream?.text).toBe('the answer is 4');
    // The last delta seen decides the phase, so the UI can show which is live.
    expect(stream?.phase).toBe('text');
  });

  it('merges token counts as they are reported', () => {
    store.applyDelta(delta({ seq: 0, tokens: { input: 100 } }));
    const stream = store.applyDelta(delta({ seq: 1, tokens: { output: 25 } }));

    expect(stream?.tokens).toEqual({ input: 100, output: 25, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('ordering', () => {
  it('drops an out-of-order delta', () => {
    store.applyDelta(delta({ seq: 5, textDelta: 'five' }));
    const stale = store.applyDelta(delta({ seq: 3, textDelta: 'three' }));

    expect(stale).toBeNull();
    expect(store.get(SESSION)?.text).toBe('five');
  });

  it('drops a duplicated delta', () => {
    // A retried POST that in fact arrived the first time would otherwise
    // double the text on screen.
    store.applyDelta(delta({ seq: 1, textDelta: 'once' }));
    const dup = store.applyDelta(delta({ seq: 1, textDelta: 'once' }));

    expect(dup).toBeNull();
    expect(store.get(SESSION)?.text).toBe('once');
  });

  it('accepts deltas with no seq at all', () => {
    store.applyDelta(delta({ textDelta: 'a' }));
    const stream = store.applyDelta(delta({ textDelta: 'b' }));

    expect(stream?.text).toBe('ab');
  });

  it('starts fresh when the message id changes', () => {
    store.applyDelta(delta({ seq: 9, textDelta: 'previous message' }));
    const stream = store.applyDelta(
      delta({ messageId: 'msg-2', seq: 0, textDelta: 'new message' }),
    );

    // Both the buffer and the seq window reset, or the new message's seq 0
    // would be dropped as stale against the old message's seq 9.
    expect(stream?.text).toBe('new message');
    expect(stream?.messageId).toBe('msg-2');
  });
});

describe('truncation', () => {
  it('keeps the tail once the buffer is full', () => {
    const cap = 32 * 1024;
    store.applyDelta(delta({ seq: 0, textDelta: 'x'.repeat(cap) }));
    const stream = store.applyDelta(delta({ seq: 1, textDelta: 'THE-END' }));

    expect(stream?.text).toHaveLength(cap);
    expect(stream?.text.endsWith('THE-END')).toBe(true);
    expect(stream?.text.startsWith('x')).toBe(true);
  });
});

describe('lifecycle', () => {
  it('emits stream:update on each delta', () => {
    const seen: LiveStream[] = [];
    store.on('stream:update', (s: LiveStream) => seen.push(s));

    store.applyDelta(delta({ seq: 0, textDelta: 'a' }));
    store.applyDelta(delta({ seq: 1, textDelta: 'b' }));

    expect(seen).toHaveLength(2);
    expect(seen[1].text).toBe('ab');
  });

  it('emits stream:end and forgets the stream when done', () => {
    const ended: string[] = [];
    store.on('stream:end', (id: string) => ended.push(id));

    store.applyDelta(delta({ seq: 0, textDelta: 'a' }));
    const result = store.applyDelta(delta({ seq: 1, done: true }));

    expect(result).toBeNull();
    expect(ended).toEqual([SESSION]);
    expect(store.get(SESSION)).toBeUndefined();
  });

  it('does not emit an end for a message that never streamed', () => {
    // An assistant message containing only tool calls produces no deltas, but
    // the harness still closes it. That must not fire a spurious stream:end.
    const ended: string[] = [];
    store.on('stream:end', (id: string) => ended.push(id));

    store.applyDelta(delta({ seq: 0, done: true }));

    expect(ended).toEqual([]);
  });

  it('finish() is idempotent and silent for an unknown session', () => {
    const ended: string[] = [];
    store.on('stream:end', (id: string) => ended.push(id));

    store.applyDelta(delta({ seq: 0, textDelta: 'a' }));
    store.finish(SESSION);
    store.finish(SESSION);
    store.finish('never-existed');

    expect(ended).toEqual([SESSION]);
  });

  it('sweeps a stream whose harness went away mid-generation', () => {
    // A crashed or Ctrl-C'd agent must not leave a permanent "typing" indicator.
    const ended: string[] = [];
    store.on('stream:end', (id: string) => ended.push(id));

    store.applyDelta(delta({ seq: 0, textDelta: 'partial' }), 1_000);

    store.sweep(30_000);
    expect(store.get(SESSION)).toBeDefined(); // still within the idle window

    store.sweep(70_000);
    expect(store.get(SESSION)).toBeUndefined();
    expect(ended).toEqual([SESSION]);
  });

  it('reports every live stream for WebSocket replay', () => {
    store.applyDelta(delta({ seq: 0, textDelta: 'one' }));
    store.applyDelta(delta({ sessionId: 'sess-2', seq: 0, textDelta: 'two' }));

    expect(store.getAll().map((s) => s.sessionId).sort()).toEqual(['sess-1', 'sess-2']);
  });
});

describe('PII redaction', () => {
  beforeEach(() => {
    store.setStringFilter((text) => (filterPii({ prompt: text }).prompt ?? ''));
  });

  it('redacts a secret split across two deltas', () => {
    // The case that makes per-delta filtering wrong: neither half matches on
    // its own, so only filtering the accumulated buffer catches it.
    const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const midpoint = Math.floor(secret.length / 2);

    store.applyDelta(delta({ seq: 0, textDelta: `key is ${secret.slice(0, midpoint)}` }));
    const stream = store.applyDelta(delta({ seq: 1, textDelta: secret.slice(midpoint) }));

    expect(stream?.text).not.toContain(secret);
  });

  it('redacts thinking as well as text', () => {
    const secret = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const stream = store.applyDelta(delta({ seq: 0, thinkingDelta: `use ${secret}` }));

    expect(stream?.thinking).not.toContain(secret);
  });

  it('leaves ordinary prose alone', () => {
    const stream = store.applyDelta(delta({ seq: 0, textDelta: 'Reversing a linked list.' }));
    expect(stream?.text).toBe('Reversing a linked list.');
  });
});
