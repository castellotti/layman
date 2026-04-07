import { describe, it, expect } from 'vitest';
import { classifyLevel } from './monitor.js';
import {
  parseDriftResponse,
  buildGoalDriftUserMessage,
  buildRulesDriftUserMessage,
} from './prompts.js';
import type { DriftSessionState } from './types.js';

// ---------------------------------------------------------------------------
// classifyLevel
// ---------------------------------------------------------------------------

describe('classifyLevel', () => {
  const thresholds = { green: 15, yellow: 30, orange: 50 };

  it('returns green for 0%', () => {
    expect(classifyLevel(0, thresholds)).toBe('green');
  });

  it('returns green below green threshold', () => {
    expect(classifyLevel(14.9, thresholds)).toBe('green');
  });

  it('returns yellow at green threshold boundary', () => {
    expect(classifyLevel(15, thresholds)).toBe('yellow');
  });

  it('returns yellow between green and yellow thresholds', () => {
    expect(classifyLevel(25, thresholds)).toBe('yellow');
  });

  it('returns orange at yellow threshold boundary', () => {
    expect(classifyLevel(30, thresholds)).toBe('orange');
  });

  it('returns orange between yellow and orange thresholds', () => {
    expect(classifyLevel(45, thresholds)).toBe('orange');
  });

  it('returns red at orange threshold boundary', () => {
    expect(classifyLevel(50, thresholds)).toBe('red');
  });

  it('returns red for 100%', () => {
    expect(classifyLevel(100, thresholds)).toBe('red');
  });

  it('handles misordered thresholds via runtime guard', () => {
    const bad = { green: 50, yellow: 30, orange: 15 };
    // Should sort to [15, 30, 50] internally
    expect(classifyLevel(10, bad)).toBe('green');
    expect(classifyLevel(20, bad)).toBe('yellow');
    expect(classifyLevel(40, bad)).toBe('orange');
    expect(classifyLevel(60, bad)).toBe('red');
  });
});

// ---------------------------------------------------------------------------
// parseDriftResponse
// ---------------------------------------------------------------------------

describe('parseDriftResponse', () => {
  it('parses valid JSON response', () => {
    const result = parseDriftResponse(JSON.stringify({
      driftPercentage: 42,
      summary: 'Agent drifting from original goal',
      driftIndicators: ['scope creep'],
      phantomReferences: ['nonexistent.ts'],
      patternBreaks: ['changed approach'],
    }));
    expect(result.driftPercentage).toBe(42);
    expect(result.summary).toBe('Agent drifting from original goal');
    expect(result.indicators).toEqual(['scope creep']);
    expect(result.phantomReferences).toEqual(['nonexistent.ts']);
    expect(result.patternBreaks).toEqual(['changed approach']);
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const text = '```json\n{"driftPercentage": 10, "summary": "On track"}\n```';
    const result = parseDriftResponse(text);
    expect(result.driftPercentage).toBe(10);
    expect(result.summary).toBe('On track');
  });

  it('falls back to 25% on invalid JSON', () => {
    const result = parseDriftResponse('this is not json');
    expect(result.driftPercentage).toBe(25);
    expect(result.summary).toContain('could not be parsed');
  });

  it('falls back to 25% when driftPercentage is NaN', () => {
    const result = parseDriftResponse(JSON.stringify({
      driftPercentage: 'not a number',
      summary: 'test',
    }));
    expect(result.driftPercentage).toBe(25);
  });

  it('falls back to 25% when driftPercentage is missing', () => {
    const result = parseDriftResponse(JSON.stringify({
      summary: 'no percentage',
    }));
    expect(result.driftPercentage).toBe(25);
  });

  it('clamps driftPercentage to [0, 100]', () => {
    expect(parseDriftResponse(JSON.stringify({
      driftPercentage: 150, summary: 'over',
    })).driftPercentage).toBe(100);

    expect(parseDriftResponse(JSON.stringify({
      driftPercentage: -10, summary: 'under',
    })).driftPercentage).toBe(0);
  });

  it('returns undefined for missing array fields', () => {
    const result = parseDriftResponse(JSON.stringify({
      driftPercentage: 5, summary: 'clean',
    }));
    expect(result.indicators).toBeUndefined();
    expect(result.violations).toBeUndefined();
    expect(result.phantomReferences).toBeUndefined();
    expect(result.patternBreaks).toBeUndefined();
  });

  it('parses violations array', () => {
    const result = parseDriftResponse(JSON.stringify({
      driftPercentage: 40,
      summary: 'non-compliant',
      violations: [{ rule: 'no mocks', action: 'used vi.mock', severity: 'major' }],
    }));
    expect(result.violations).toHaveLength(1);
    expect(result.violations![0].rule).toBe('no mocks');
  });
});

// ---------------------------------------------------------------------------
// EMA smoothing math
// ---------------------------------------------------------------------------

describe('EMA smoothing', () => {
  const EMA_ALPHA = 0.3;
  const ema = (old: number, next: number) => old * (1 - EMA_ALPHA) + next * EMA_ALPHA;

  it('produces expected value from zero baseline', () => {
    // First reading: 0 * 0.7 + 60 * 0.3 = 18
    expect(ema(0, 60)).toBe(18);
  });

  it('converges on sustained high readings', () => {
    let score = 0;
    for (let i = 0; i < 20; i++) score = ema(score, 80);
    // Should converge close to 80
    expect(score).toBeGreaterThan(79);
    expect(score).toBeLessThanOrEqual(80);
  });

  it('single spike decays over subsequent low readings', () => {
    let score = ema(0, 90); // spike: 27
    expect(score).toBe(27);
    score = ema(score, 0); // 27 * 0.7 = 18.9
    expect(score).toBeCloseTo(18.9, 5);
    score = ema(score, 0); // 18.9 * 0.7 = 13.23
    expect(score).toBeCloseTo(13.23, 5);
    // Should be below 15 (green threshold) after two zero readings
    expect(score).toBeLessThan(15);
  });
});

// ---------------------------------------------------------------------------
// buildGoalDriftUserMessage
// ---------------------------------------------------------------------------

describe('buildGoalDriftUserMessage', () => {
  function makeState(overrides: Partial<DriftSessionState> = {}): DriftSessionState {
    return {
      sessionId: 'test-session',
      initialPrompt: 'Fix the auth bug',
      recentPrompts: ['Also update the tests'],
      recentToolCalls: [
        { toolName: 'Bash', toolInput: { command: 'npm test' } },
      ],
      toolCallsSinceLastCheck: 0,
      lastCheckTimestamp: Date.now(),
      sessionGoalDriftPct: 0,
      sessionGoalDriftLevel: 'green',
      rulesDriftPct: 0,
      rulesDriftLevel: 'green',
      lastCheckModel: '',
      claudeMdContents: new Map(),
      interventionPending: false,
      lastInterventionTimestamp: 0,
      checkInProgress: false,
      lastGoalResult: null,
      lastRulesResult: null,
      dismissedItems: { indicators: [], patternBreaks: [], phantomReferences: [], violations: [] },
      ...overrides,
    };
  }

  it('includes initial prompt', () => {
    const msg = buildGoalDriftUserMessage(makeState());
    expect(msg).toContain('Fix the auth bug');
  });

  it('includes recent prompts', () => {
    const msg = buildGoalDriftUserMessage(makeState());
    expect(msg).toContain('Also update the tests');
  });

  it('includes tool calls', () => {
    const msg = buildGoalDriftUserMessage(makeState());
    expect(msg).toContain('Bash');
    expect(msg).toContain('npm test');
  });

  it('truncates long prompts', () => {
    const longPrompt = 'x'.repeat(1000);
    const msg = buildGoalDriftUserMessage(makeState({ recentPrompts: [longPrompt] }));
    // Should be truncated to 300 chars
    expect(msg.includes('x'.repeat(301))).toBe(false);
  });

  it('handles no initial prompt', () => {
    const msg = buildGoalDriftUserMessage(makeState({ initialPrompt: null }));
    expect(msg).toContain('no initial prompt');
  });
});

// ---------------------------------------------------------------------------
// buildRulesDriftUserMessage
// ---------------------------------------------------------------------------

describe('buildRulesDriftUserMessage', () => {
  function makeState(overrides: Partial<DriftSessionState> = {}): DriftSessionState {
    return {
      sessionId: 'test-session',
      initialPrompt: null,
      recentPrompts: [],
      recentToolCalls: [
        { toolName: 'Edit', toolInput: { file_path: '/src/test.ts' } },
      ],
      toolCallsSinceLastCheck: 0,
      lastCheckTimestamp: Date.now(),
      sessionGoalDriftPct: 0,
      sessionGoalDriftLevel: 'green',
      rulesDriftPct: 0,
      rulesDriftLevel: 'green',
      lastCheckModel: '',
      claudeMdContents: new Map([['CLAUDE.md', 'Do not use vi.mock']]),
      interventionPending: false,
      lastInterventionTimestamp: 0,
      checkInProgress: false,
      lastGoalResult: null,
      lastRulesResult: null,
      dismissedItems: { indicators: [], patternBreaks: [], phantomReferences: [], violations: [] },
      ...overrides,
    };
  }

  it('includes CLAUDE.md rules', () => {
    const msg = buildRulesDriftUserMessage(makeState());
    expect(msg).toContain('Do not use vi.mock');
    expect(msg).toContain('CLAUDE.md');
  });

  it('includes tool calls', () => {
    const msg = buildRulesDriftUserMessage(makeState());
    expect(msg).toContain('Edit');
    expect(msg).toContain('/src/test.ts');
  });

  it('handles empty claudeMdContents', () => {
    const msg = buildRulesDriftUserMessage(makeState({ claudeMdContents: new Map() }));
    expect(msg).toContain('no CLAUDE.md files loaded');
  });
});
