import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TtsPlayer, BlobCache } from './tts.js';
import type { SpeechOptions, TtsAudio, TtsRuntime, QueueItem } from './tts.js';

const OPTS: SpeechOptions = {
  model: 'kokoro', voice: 'af_heart', speed: 1, playbackRate: 1,
  preservePitch: true, direct: false, endpoint: 'http://localhost:8000', apiKey: '',
};

/** A fake audio element whose `ended` we fire by hand. */
class FakeAudio implements TtsAudio {
  src = '';
  playbackRate = 1;
  preservesPitch = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  playCalls = 0;
  /** Set to make the next play() reject the way a browser autoplay block does. */
  static blockPlayback = false;

  async play(): Promise<void> {
    this.playCalls++;
    if (FakeAudio.blockPlayback) {
      const err = new Error('play() failed because the user did not interact with the document first');
      err.name = 'NotAllowedError';
      throw err;
    }
  }
  pause(): void { this.paused = true; }
  finish(): void { this.onended?.(); }
}

interface Harness {
  player: TtsPlayer;
  audio: FakeAudio;
  runtime: TtsRuntime;
  synthesized: string[];
  createdUrls: string[];
  revokedUrls: string[];
}

function harness(overrides: Partial<TtsRuntime> = {}): Harness {
  const audio = new FakeAudio();
  const synthesized: string[] = [];
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  let urlCounter = 0;

  const runtime: TtsRuntime = {
    synthesize: async (text) => {
      synthesized.push(text);
      return new Blob([text]);
    },
    createAudio: () => audio,
    createObjectUrl: () => {
      const url = `blob:${++urlCounter}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectUrl: (url) => { revokedUrls.push(url); },
    ...overrides,
  };

  return { player: new TtsPlayer(runtime), audio, runtime, synthesized, createdUrls, revokedUrls };
}

function item(id: string, text = `text ${id}`, opts: SpeechOptions = OPTS): QueueItem {
  return { id, text, label: `label ${id}`, opts };
}

/** Let the player's internal awaits settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { FakeAudio.blockPlayback = false; });

describe('BlobCache', () => {
  const blob = (s: string) => new Blob([s]);

  it('returns a cached blob for identical text and voice settings', () => {
    const cache = new BlobCache();
    cache.set('hello', OPTS, blob('a'));
    expect(cache.get('hello', OPTS)).toBeDefined();
  });

  it('misses when the voice, model or speed differs', () => {
    const cache = new BlobCache();
    cache.set('hello', OPTS, blob('a'));
    expect(cache.get('hello', { ...OPTS, voice: 'af_sky' })).toBeUndefined();
    expect(cache.get('hello', { ...OPTS, model: 'piper' })).toBeUndefined();
    expect(cache.get('hello', { ...OPTS, speed: 2 })).toBeUndefined();
  });

  it('ignores playbackRate, which is applied at play time not synthesis time', () => {
    const cache = new BlobCache();
    cache.set('hello', OPTS, blob('a'));
    expect(cache.get('hello', { ...OPTS, playbackRate: 2, preservePitch: false })).toBeDefined();
  });

  it('evicts least-recently-used past the limit', () => {
    const cache = new BlobCache(2);
    cache.set('a', OPTS, blob('a'));
    cache.set('b', OPTS, blob('b'));
    cache.get('a', OPTS);            // 'a' is now most recent, so 'b' should go
    cache.set('c', OPTS, blob('c'));

    expect(cache.size).toBe(2);
    expect(cache.get('a', OPTS)).toBeDefined();
    expect(cache.get('b', OPTS)).toBeUndefined();
    expect(cache.get('c', OPTS)).toBeDefined();
  });
});

describe('TtsPlayer — queue ordering', () => {
  it('plays one utterance at a time in FIFO order', async () => {
    const { player, audio, synthesized } = harness();

    player.enqueue(item('a'));
    player.enqueue(item('b'));
    player.enqueue(item('c'));
    await settle();

    // Only the first has been synthesised and started.
    expect(synthesized).toEqual(['text a']);
    expect(player.getState().current?.id).toBe('a');
    expect(player.getState().queueDepth).toBe(3);

    audio.finish();
    await settle();
    expect(player.getState().current?.id).toBe('b');

    audio.finish();
    await settle();
    expect(player.getState().current?.id).toBe('c');

    audio.finish();
    await settle();
    expect(player.getState().status).toBe('idle');
    expect(player.getState().queueDepth).toBe(0);
    expect(synthesized).toEqual(['text a', 'text b', 'text c']);
  });

  it('dedupes by id so a re-render never double-queues', async () => {
    const { player, synthesized } = harness();

    player.enqueue(item('a'));
    player.enqueue(item('a'));
    player.enqueue(item('a'));
    await settle();

    expect(player.getState().queueDepth).toBe(1);
    expect(synthesized).toEqual(['text a']);
  });

  it('ignores empty text', async () => {
    const { player, synthesized } = harness();
    player.enqueue(item('a', '   '));
    await settle();
    expect(synthesized).toEqual([]);
    expect(player.getState().status).toBe('idle');
  });

  it('reuses one audio element across utterances', async () => {
    const created: TtsAudio[] = [];
    const h = harness();
    const player = new TtsPlayer({
      ...h.runtime,
      createAudio: () => { const a = new FakeAudio(); created.push(a); return a; },
    });

    player.enqueue(item('a'));
    await settle();
    (created[0] as FakeAudio).finish();
    await settle();

    expect(created).toHaveLength(1);
  });
});

describe('TtsPlayer — transport controls', () => {
  it('skip abandons the current utterance and starts the next', async () => {
    const { player, audio, synthesized } = harness();
    player.enqueue(item('a'));
    player.enqueue(item('b'));
    await settle();

    player.skip();
    await settle();

    expect(audio.paused).toBe(true);
    expect(synthesized).toEqual(['text a', 'text b']);
    expect(player.getState().current?.id).toBe('b');
  });

  it('stop silences everything and empties the queue', async () => {
    const { player, synthesized } = harness();
    player.enqueue(item('a'));
    player.enqueue(item('b'));
    await settle();

    player.stop();
    await settle();

    expect(player.getState()).toMatchObject({ status: 'idle', current: null, queueDepth: 0 });
    expect(synthesized).toEqual(['text a']);
  });

  it('clear empties the queue but leaves the current utterance playing', async () => {
    const { player } = harness();
    player.enqueue(item('a'));
    player.enqueue(item('b'));
    await settle();

    player.clear();

    expect(player.getState().current?.id).toBe('a');
    expect(player.getState().queueDepth).toBe(0);
  });

  it('replaceWith drops the queue and speaks the new item immediately', async () => {
    const { player, synthesized } = harness();
    player.enqueue(item('a'));
    player.enqueue(item('b'));
    await settle();

    player.replaceWith(item('c'));
    await settle();

    expect(player.getState().current?.id).toBe('c');
    expect(synthesized).toEqual(['text a', 'text c']);
  });

  it('muting stops playback and refuses new work until unmuted', async () => {
    const { player, synthesized } = harness();
    player.enqueue(item('a'));
    await settle();

    player.setMuted(true);
    player.enqueue(item('b'));
    await settle();

    expect(player.getState().muted).toBe(true);
    expect(player.getState().status).toBe('idle');
    expect(synthesized).toEqual(['text a']);

    player.setMuted(false);
    player.enqueue(item('c'));
    await settle();
    expect(synthesized).toEqual(['text a', 'text c']);
  });

  it('a stop during synthesis does not produce a delayed utterance', async () => {
    // The generation guard: without it, the in-flight fetch resolves after the
    // user hit stop and starts speaking anyway.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness({
      synthesize: async (text) => { await gate; return new Blob([text]); },
    });

    h.player.enqueue(item('a'));
    await settle();
    expect(h.player.getState().status).toBe('loading');

    h.player.stop();
    release();
    await settle();

    expect(h.player.getState().status).toBe('idle');
    expect(h.audio.playCalls).toBe(0);
  });

  it('isActive reports both the playing item and queued ones', async () => {
    const { player } = harness();
    player.enqueue(item('a'));
    player.enqueue(item('b'));
    await settle();

    expect(player.isActive('a')).toBe(true);
    expect(player.isActive('b')).toBe(true);
    expect(player.isActive('c')).toBe(false);
  });
});

describe('TtsPlayer — autoplay policy', () => {
  it('surfaces a blocked play() as state and keeps the utterance queued', async () => {
    FakeAudio.blockPlayback = true;
    const { player } = harness();

    player.enqueue(item('a'));
    await settle();

    const state = player.getState();
    expect(state.blocked).toBe(true);
    expect(state.status).toBe('idle');
    // The whole point: the item is still there, so one click plays it.
    expect(state.queueDepth).toBe(1);
    // A block is not an error — showing a red message here would be wrong.
    expect(state.error).toBeNull();
  });

  it('resume() after a user gesture plays the queued utterance', async () => {
    FakeAudio.blockPlayback = true;
    const { player, audio } = harness();

    player.enqueue(item('a'));
    await settle();
    expect(player.getState().blocked).toBe(true);

    FakeAudio.blockPlayback = false;
    player.resume();
    await settle();

    expect(player.getState()).toMatchObject({ blocked: false, status: 'playing' });
    expect(player.getState().current?.id).toBe('a');
    expect(audio.playCalls).toBe(2);
  });

  it('does not synthesise again on resume — the blob is cached', async () => {
    FakeAudio.blockPlayback = true;
    const { player, synthesized } = harness();

    player.enqueue(item('a'));
    await settle();

    FakeAudio.blockPlayback = false;
    player.resume();
    await settle();

    expect(synthesized).toEqual(['text a']);
  });

  it('resume() is a no-op when not blocked', async () => {
    const { player, audio } = harness();
    player.enqueue(item('a'));
    await settle();
    const calls = audio.playCalls;

    player.resume();
    await settle();

    expect(audio.playCalls).toBe(calls);
  });
});

describe('TtsPlayer — failures', () => {
  it('records a synthesis error, drops the item and continues the queue', async () => {
    let first = true;
    const h = harness({
      synthesize: async (text) => {
        if (first) { first = false; throw new Error('speaches is unreachable'); }
        return new Blob([text]);
      },
    });

    h.player.enqueue(item('a'));
    h.player.enqueue(item('b'));
    await settle();

    expect(h.player.getState().error).toBe('speaches is unreachable');
    expect(h.player.getState().current?.id).toBe('b');
  });

  it('recovers from a playback error', async () => {
    const { player, audio } = harness();
    player.enqueue(item('a'));
    player.enqueue(item('b'));
    await settle();

    audio.onerror?.();
    await settle();

    expect(player.getState().error).toBe('Audio playback failed');
    expect(player.getState().current?.id).toBe('b');
  });
});

describe('TtsPlayer — object URLs and playback settings', () => {
  it('revokes each object URL when its utterance ends', async () => {
    const { player, audio, createdUrls, revokedUrls } = harness();

    player.enqueue(item('a'));
    await settle();
    audio.finish();
    await settle();

    expect(createdUrls).toHaveLength(1);
    expect(revokedUrls).toEqual(createdUrls);
  });

  it('revokes the URL on stop as well, so nothing leaks', async () => {
    const { player, createdUrls, revokedUrls } = harness();
    player.enqueue(item('a'));
    await settle();

    player.stop();

    expect(revokedUrls).toEqual(createdUrls);
  });

  it('applies playbackRate and preservesPitch to the element', async () => {
    // speaches has no pitch parameter, so this is the only place pitch moves.
    const { player, audio } = harness();

    player.enqueue(item('a', 'text a', { ...OPTS, playbackRate: 1.75, preservePitch: false }));
    await settle();

    expect(audio.playbackRate).toBe(1.75);
    expect(audio.preservesPitch).toBe(false);
  });
});

describe('TtsPlayer — subscription', () => {
  it('notifies subscribers and hands back a fresh state object each time', async () => {
    const { player, audio } = harness();
    const seen: unknown[] = [];
    const unsubscribe = player.subscribe(() => seen.push(player.getState()));

    player.enqueue(item('a'));
    await settle();
    audio.finish();
    await settle();

    expect(seen.length).toBeGreaterThan(1);
    // useSyncExternalStore compares by identity — a mutated object would not re-render.
    expect(new Set(seen).size).toBe(seen.length);

    unsubscribe();
    const count = seen.length;
    player.enqueue(item('b'));
    await settle();
    expect(seen).toHaveLength(count);
  });
});

describe('synthesize()', () => {
  /** Records fetch calls with enough typing to read the body back. */
  function stubFetchOk() {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(new Blob(['audio']), { status: 200 }));
    vi.stubGlobal('fetch', mock);
    return {
      url: () => mock.mock.calls[0][0],
      body: () => JSON.parse(String(mock.mock.calls[0][1]?.body)) as Record<string, unknown>,
      headers: () => (mock.mock.calls[0][1]?.headers ?? {}) as Record<string, string>,
    };
  }

  it('posts to the Layman proxy by default', async () => {
    const calls = stubFetchOk();

    const { synthesize } = await import('./tts.js');
    await synthesize('hello', OPTS);

    expect(calls.url()).toBe('/api/tts/speech');
    expect(calls.body()).toMatchObject({ text: 'hello', format: 'mp3' });
    vi.unstubAllGlobals();
  });

  it('calls speaches directly in direct mode, using its field names', async () => {
    const calls = stubFetchOk();

    const { synthesize } = await import('./tts.js');
    await synthesize('hello', { ...OPTS, direct: true, apiKey: 'sk-1' });

    expect(calls.url()).toBe('http://localhost:8000/v1/audio/speech');
    // speaches wants `input`, not `text`.
    expect(calls.body()).toMatchObject({ input: 'hello', response_format: 'mp3' });
    expect(calls.headers().Authorization).toBe('Bearer sk-1');
    vi.unstubAllGlobals();
  });

  it('unwraps the proxy error envelope so the message reaches the UI', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ error: 'Input should be less than or equal to 4' }),
      { status: 422 },
    ));

    const { synthesize } = await import('./tts.js');
    await expect(synthesize('hello', OPTS)).rejects.toThrow('Input should be less than or equal to 4');
    vi.unstubAllGlobals();
  });
});
