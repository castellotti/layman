import { describe, it, expect } from 'vitest';
import { formatTokens, thinkingShare, tokenBreakdown } from './format.js';

describe('formatTokens', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(51_070)).toBe('51.1k');
    expect(formatTokens(2_400_000)).toBe('2.4M');
  });
});

describe('thinkingShare', () => {
  it('is thinking as a whole percent of output (thinking is a part of it), or null with no output', () => {
    expect(thinkingShare(1355, 2786)).toBe(49);
    expect(thinkingShare(0, 0)).toBeNull();
  });
});

describe('tokenBreakdown', () => {
  it('lists each kind, thinking under output with its share', () => {
    expect(tokenBreakdown({
      totalInputTokens: 51070, totalOutputTokens: 2786, totalReasoningTokens: 1355, totalCacheReadTokens: 7100, totalCacheWriteTokens: 0,
    })).toBe('Input: 51,070\nOutput: 2,786\n  of which thinking: 1,355 (49% of output)\nCache read: 7,100');
  });

  it('leaves out a kind that is 0: the provider never sent it (cache write on openai-completions)', () => {
    expect(tokenBreakdown({
      totalInputTokens: 10, totalOutputTokens: 5, totalReasoningTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
    })).toBe('Input: 10\nOutput: 5');
  });

  it('leaves out the kinds a harness does not report (Claude Code)', () => {
    expect(tokenBreakdown({ totalInputTokens: 10, totalOutputTokens: 5 })).toBe('Input: 10\nOutput: 5');
  });

  it('takes the share of the output that reports thinking, in a mixed aggregate', () => {
    // 1,000 output: 200 from pi sessions (100 of it thinking), 800 from Claude Code.
    expect(tokenBreakdown({ totalInputTokens: 10, totalOutputTokens: 1000, totalReasoningTokens: 100 }, 200))
      .toBe('Input: 10\nOutput: 1,000\n  of which thinking: 100 (50% of output)');
  });
});
