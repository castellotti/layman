import { describe, expect, it } from 'vitest';
import { godotFrameSrc, godotTabState } from './matrix-godot.js';

describe('godotFrameSrc', () => {
  it('is a same-origin path with the embed parameters', () => {
    expect(godotFrameSrc({ sessionId: 'abc-1', window: '15m' }))
      .toBe('/styx/godot/index.html?embed=1&api=/api/styx&poll=2&relative=15m&session=abc-1');
    expect(godotFrameSrc({ sessionId: null, window: '1m' })).toContain('relative=60s');
  });

  it('omits relative for All on a session, and asks for a day with no session', () => {
    expect(godotFrameSrc({ sessionId: 's', window: 'all' })).not.toContain('relative');
    expect(godotFrameSrc({ sessionId: null, window: 'all' })).toContain('relative=1d');
  });

  it('encodes the session id and never starts with // or http', () => {
    const src = godotFrameSrc({ sessionId: 'a&b=c', window: '1h' });
    expect(src).toContain('session=a%26b%3Dc');
    expect(src).toMatch(/^\/styx\/godot\//);
  });
});

describe('godotTabState', () => {
  const base = { secure: true, buildPresent: true, motionFull: true, runAnyway: false };
  it('runs when everything allows it', () => expect(godotTabState(base)).toBe('run'));
  it('puts an insecure page first', () => {
    expect(godotTabState({ ...base, secure: false, buildPresent: false })).toBe('insecure');
  });
  it('waits for the status, then explains a missing build', () => {
    expect(godotTabState({ ...base, buildPresent: null })).toBe('checking');
    expect(godotTabState({ ...base, buildPresent: false })).toBe('no-build');
  });
  it('does not start the engine under reduced motion until asked', () => {
    expect(godotTabState({ ...base, motionFull: false })).toBe('motion-off');
    expect(godotTabState({ ...base, motionFull: false, runAnyway: true })).toBe('run');
  });
});
