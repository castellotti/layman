import { describe, it, expect } from 'vitest';
import { toSpeakableText, truncateForSpeech, speechTextForEvent } from './tts-text.js';
import type { TimelineEvent } from './types.js';

function agentResponse(prompt: string, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 'e1',
    type: 'agent_response',
    timestamp: 1,
    sessionId: 's1',
    agentType: 'claude-code',
    data: { prompt },
    ...extra,
  } as TimelineEvent;
}

describe('toSpeakableText — code', () => {
  it('announces fenced code by default instead of reading it', () => {
    const out = toSpeakableText('Here is the fix:\n\n```js\nconst a = 1;\nfoo(a);\n```\n\nDone.');
    expect(out).toContain('Code block.');
    expect(out).not.toContain('const a = 1');
  });

  it('drops fenced code entirely when codeBlocks is skip', () => {
    const out = toSpeakableText('Before\n\n```\nnoise\n```\n\nAfter', { codeBlocks: 'skip' });
    expect(out).not.toContain('Code block');
    expect(out).not.toContain('noise');
    expect(out).toContain('Before');
    expect(out).toContain('After');
  });

  it('handles tilde fences too', () => {
    expect(toSpeakableText('a\n\n~~~\nhidden\n~~~\n\nb', { codeBlocks: 'skip' })).not.toContain('hidden');
  });

  it('keeps inline code contents but drops the backticks', () => {
    // Identifiers usually are the point of the sentence.
    expect(toSpeakableText('Run `pnpm build` in `packages/server`.'))
      .toBe('Run pnpm build in packages/server.');
  });

  it('does not let markdown inside a fence leak out', () => {
    const out = toSpeakableText('```\n# not a heading\n[not](a-link)\n```', { codeBlocks: 'skip' });
    expect(out).toBe('');
  });
});

describe('toSpeakableText — links and HTML', () => {
  it('reduces a markdown link to its text', () => {
    expect(toSpeakableText('See [the docs](https://example.com/a/b) for more.'))
      .toBe('See the docs for more.');
  });

  it('replaces a bare URL with the word link', () => {
    expect(toSpeakableText('Open http://localhost:8880/s/abc now.')).toBe('Open link now.');
  });

  it('drops images entirely', () => {
    expect(toSpeakableText('Result: ![render](out.png) looks right.')).toBe('Result: looks right.');
  });

  it('strips stray HTML tags', () => {
    expect(toSpeakableText('One<br>two <b>three</b>.')).toBe('One two three.');
  });
});

describe('toSpeakableText — block structure', () => {
  it('strips heading markers but keeps the words', () => {
    expect(toSpeakableText('## Summary\n\nAll three changes are in.'))
      .toBe('Summary. All three changes are in.');
  });

  it('strips blockquote and bullet markers', () => {
    expect(toSpeakableText('> quoted line\n- first\n- second')).toBe('quoted line first second');
  });

  it('leaves numbered list markers alone', () => {
    // Kokoro reads digits fine, and rewriting "1." to "One," is not worth the risk.
    expect(toSpeakableText('1. First\n2. Second')).toBe('1. First 2. Second');
  });

  it('turns a table into a comma-separated run and drops the separator row', () => {
    const out = toSpeakableText('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(out).not.toContain('|');
    expect(out).not.toContain('---');
    expect(out).toContain('a, b');
    expect(out).toContain('1, 2');
  });

  it('drops horizontal rules', () => {
    expect(toSpeakableText('above\n\n---\n\nbelow')).toBe('above. below');
  });

  it('turns paragraph breaks into sentence breaks', () => {
    expect(toSpeakableText('First para\n\nSecond para')).toBe('First para. Second para');
  });

  it('collapses whitespace and trims', () => {
    expect(toSpeakableText('  lots   of\t\tspace  ')).toBe('lots of space');
  });

  it('does not double up terminal punctuation', () => {
    expect(toSpeakableText('Done.\n\nNext.')).toBe('Done. Next.');
  });

  it('returns an empty string for empty input', () => {
    expect(toSpeakableText('')).toBe('');
    expect(toSpeakableText('   \n\n  ')).toBe('');
  });
});

describe('truncateForSpeech', () => {
  it('leaves short text alone', () => {
    expect(truncateForSpeech('Short.', 100)).toBe('Short.');
  });

  it('cuts back to a sentence boundary when one is close enough', () => {
    const text = `${'a'.repeat(70)}. ${'b'.repeat(70)}`;
    const out = truncateForSpeech(text, 100);
    expect(out).toBe(`${'a'.repeat(70)}.`);
  });

  it('falls back to a word boundary when the only sentence end is too early', () => {
    // A period at 5% of the cap would throw away almost the whole utterance.
    const text = `Hi. ${'word '.repeat(40)}`;
    const out = truncateForSpeech(text, 100);
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeGreaterThan(60);
  });

  it('never exceeds the cap by more than the ellipsis', () => {
    const out = truncateForSpeech('x'.repeat(500), 100);
    expect(out.length).toBeLessThanOrEqual(101);
  });
});

describe('toSpeakableText — maxChars', () => {
  it('applies the cap after stripping, not before', () => {
    // The code block is 200 chars of source; stripped first, the prose fits.
    const raw = `Answer here.\n\n\`\`\`\n${'x'.repeat(200)}\n\`\`\``;
    expect(toSpeakableText(raw, { codeBlocks: 'skip', maxChars: 50 })).toBe('Answer here.');
  });
});

describe('speechTextForEvent', () => {
  it('speaks the raw agent response by default', () => {
    const event = agentResponse('All three changes are in.');
    expect(speechTextForEvent(event)).toBe('All three changes are in.');
  });

  it('drops thinking blocks via getEffectiveAgentContent', () => {
    const event = agentResponse('<think>internal musing</think>The answer is 42.');
    const out = speechTextForEvent(event);
    expect(out).toBe('The answer is 42.');
    expect(out).not.toContain('musing');
  });

  it('prefers data.thinking-split events without re-extracting', () => {
    const event = agentResponse('Clean response.', { data: { prompt: 'Clean response.', thinking: 'hidden' } } as Partial<TimelineEvent>);
    expect(speechTextForEvent(event)).toBe('Clean response.');
  });

  it('speaks the laymans explanation when asked', () => {
    const event = agentResponse('Technical answer.', {
      laymans: { explanation: 'It fixed the holes.', model: 'm', latencyMs: 1, tokens: { input: 1, output: 1 } },
    });
    expect(speechTextForEvent(event, { speakLaymans: true })).toBe('It fixed the holes.');
  });

  it('falls back to the response when speakLaymans is on but no explanation exists', () => {
    // autoExplain may simply not have run for this turn — the button should
    // still say something rather than silently doing nothing.
    const event = agentResponse('Technical answer.');
    expect(speechTextForEvent(event, { speakLaymans: true })).toBe('Technical answer.');
  });
});

describe('toSpeakableText — worked example from the transcript', () => {
  // Inline code, a numbered list, an em-dash aside and a parenthetical.
  const message = [
    'All three changes are in and verified with full CGAL renders — no manifold errors.',
    '',
    '1. Plugged the six original holes in `panel_top()`',
    '2. Cut new holes at the coordinates you gave (see `BUTTON_POS`)',
    '3. Re-rendered with `openscad -o t2_top_render.png`',
    '',
    'The result is at [t2_top_render.png](http://localhost:8880/files/t2.png).',
  ].join('\n');

  it('reads as prose with no markdown artefacts left', () => {
    const out = toSpeakableText(message);
    expect(out).not.toMatch(/[`|#>]/);
    expect(out).not.toContain('http');
    expect(out).not.toContain('](');
    expect(out).toContain('panel_top()');
    expect(out).toContain('BUTTON_POS');
    expect(out).toContain('t2_top_render.png');
    expect(out).toContain('— no manifold errors');
  });
});
