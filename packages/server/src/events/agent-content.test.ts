import { describe, it, expect } from 'vitest';
import { extractReasoning } from './agent-content.js';

describe('extractReasoning', () => {
  it('extracts <think> blocks and strips them from the response', () => {
    const result = extractReasoning('<think>My reasoning here</think>Final answer.');
    expect(result.thinking).toBe('My reasoning here');
    expect(result.response).toBe('Final answer.');
  });

  it('decodes HTML entities in extracted thinking', () => {
    const result = extractReasoning('<think>a &lt; b &amp;&amp; c &gt; d</think>Answer.');
    expect(result.thinking).toBe('a < b && c > d');
    expect(result.response).toBe('Answer.');
  });

  it('decodes a double-escaped entity exactly one level, not two', () => {
    // "&amp;lt;" is the literal text "&lt;" escaped once more. A naive chain of
    // sequential replaces decodes it twice, producing "<" instead of "&lt;".
    const result = extractReasoning('<think>&amp;lt;</think>Answer.');
    expect(result.thinking).toBe('&lt;');
  });

  it('returns null thinking when no reasoning block is present', () => {
    const result = extractReasoning('Just an answer.');
    expect(result.thinking).toBeNull();
    expect(result.response).toBe('Just an answer.');
  });
});
