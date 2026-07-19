import { describe, it, expect } from 'vitest';
import {
  computeThresholds,
  computePanelVisibility,
  panelSetKey,
  buildPanelLayout,
  DEFAULT_PANEL_VISIBILITY,
  LOGS_MIN,
  INVEST_W,
  SETTINGS_W,
  type MeasuredWidths,
} from './useExpandingLayout.js';

// Representative measured widths (roughly matches a mid-length Bash command row).
const MEASURED: MeasuredWidths = { maxText: 480, timeW: 48 };

describe('computeThresholds', () => {
  it('derives LOGS_AT/INVEST_AT/SETTINGS_AT strictly increasing and content-driven', () => {
    const t = computeThresholds(MEASURED, 1280);
    expect(t.logsAt).toBe(t.dashNeeded + LOGS_MIN);
    expect(t.investAt).toBe(t.logsAt + INVEST_W + 420);
    expect(t.settingsAt).toBe(t.investAt + SETTINGS_W + 280);
    expect(t.logsAt).toBeGreaterThan(t.dashNeeded);
    expect(t.investAt).toBeGreaterThan(t.logsAt);
    expect(t.settingsAt).toBeGreaterThan(t.investAt);
  });

  it('clamps sessionDefault between 250 and 360 regardless of viewport width', () => {
    expect(computeThresholds(MEASURED, 100).sessionDefault).toBe(250);
    expect(computeThresholds(MEASURED, 100000).sessionDefault).toBe(360);
  });

  it('grows dashNeeded with wider measured row text (never truncates)', () => {
    const narrow = computeThresholds({ maxText: 200, timeW: 48 }, 1600);
    const wide = computeThresholds({ maxText: 900, timeW: 48 }, 1600);
    expect(wide.dashNeeded).toBeGreaterThan(narrow.dashNeeded);
    expect(wide.logsAt).toBeGreaterThan(narrow.logsAt);
  });
});

describe('computePanelVisibility — panel sets across representative viewports', () => {
  const cases: Array<[number, string]> = [
    [1280, 'laptop'],
    [2048, ''],
    [2560, ''],
    [3440, 'ultrawide'],
    [5120, '5K2K'],
  ];

  for (const [width, label] of cases) {
    it(`computes a visibility set for ${width}px ${label}`, () => {
      const { visibility, thresholds } = computePanelVisibility(width, MEASURED, null, DEFAULT_PANEL_VISIBILITY);
      expect(visibility.showDashboard).toBe(true);
      expect(visibility.showLogs).toBe(width >= thresholds.logsAt);
      if (!visibility.showLogs) {
        expect(visibility.showInvestigation).toBe(false);
      }
      if (visibility.showSettings) {
        expect(width).toBeGreaterThanOrEqual(thresholds.settingsAt - 25);
      }
    });
  }

  it('a narrow 1280px laptop shows Dashboard only', () => {
    const { visibility } = computePanelVisibility(1280, MEASURED, null, DEFAULT_PANEL_VISIBILITY);
    expect(visibility).toEqual({ showDashboard: true, showLogs: false, showInvestigation: false, showSettings: false });
  });

  it('a very wide 5120px viewport shows all four panels', () => {
    const { visibility } = computePanelVisibility(5120, MEASURED, null, DEFAULT_PANEL_VISIBILITY);
    expect(visibility).toEqual({ showDashboard: true, showLogs: true, showInvestigation: true, showSettings: true });
  });
});

describe('computePanelVisibility — pinning', () => {
  it('pinning dashboard hides everything else regardless of width', () => {
    const { visibility } = computePanelVisibility(5120, MEASURED, 'dashboard', DEFAULT_PANEL_VISIBILITY);
    expect(visibility).toEqual({ showDashboard: true, showLogs: false, showInvestigation: false, showSettings: false });
  });

  it('pinning stream (Logs) hides Dashboard, Investigation, and Settings', () => {
    const { visibility } = computePanelVisibility(5120, MEASURED, 'stream', DEFAULT_PANEL_VISIBILITY);
    expect(visibility).toEqual({ showDashboard: false, showLogs: true, showInvestigation: false, showSettings: false });
  });
});

describe('computePanelVisibility — hysteresis', () => {
  // A wide measured row pushes logsAt past 2250px, where sessionDefault is clamped flat
  // at its 360px ceiling — so the threshold itself stays stable across the small width
  // deltas exercised below (unlike near the unclamped, linearly-scaling region).
  const WIDE: MeasuredWidths = { maxText: 1200, timeW: 48 };

  it('does not flip Logs visibility for a small width change straddling the threshold', () => {
    const { thresholds } = computePanelVisibility(3000, WIDE, null, DEFAULT_PANEL_VISIBILITY);
    expect(thresholds.sessionDefault).toBe(360); // sanity: confirms we're in the clamped region
    const justBelow = thresholds.logsAt - 1;
    const justAbove = thresholds.logsAt + 1;

    // Starting hidden, a width just above the threshold but within the dead zone stays hidden.
    const stillHidden = computePanelVisibility(justAbove, WIDE, null, { ...DEFAULT_PANEL_VISIBILITY, showLogs: false });
    expect(stillHidden.visibility.showLogs).toBe(false);

    // Starting shown, a width just below the threshold but within the dead zone stays shown.
    const stillShown = computePanelVisibility(justBelow, WIDE, null, { ...DEFAULT_PANEL_VISIBILITY, showLogs: true });
    expect(stillShown.visibility.showLogs).toBe(true);
  });

  it('flips once the width clears the hysteresis band', () => {
    const { thresholds } = computePanelVisibility(3000, WIDE, null, DEFAULT_PANEL_VISIBILITY);
    const farAbove = thresholds.logsAt + 40;
    const result = computePanelVisibility(farAbove, WIDE, null, { ...DEFAULT_PANEL_VISIBILITY, showLogs: false });
    expect(result.visibility.showLogs).toBe(true);
  });
});

describe('panelSetKey', () => {
  it('produces a stable, distinguishing key per visibility combination', () => {
    expect(panelSetKey({ showDashboard: true, showLogs: false, showInvestigation: false, showSettings: false })).toBe('1000');
    expect(panelSetKey({ showDashboard: true, showLogs: true, showInvestigation: true, showSettings: true })).toBe('1111');
  });
});

describe('buildPanelLayout', () => {
  it('uses defaults when no split overrides are present', () => {
    const { visibility, thresholds } = computePanelVisibility(3440, MEASURED, null, DEFAULT_PANEL_VISIBILITY);
    const layout = buildPanelLayout(visibility, thresholds, {});
    expect(layout.sessionListWidth).toBe(thresholds.sessionDefault);
    expect(layout.investigationWidth).toBe(INVEST_W);
  });

  it('applies split overrides without touching the underlying thresholds', () => {
    const { visibility, thresholds } = computePanelVisibility(3440, MEASURED, null, DEFAULT_PANEL_VISIBILITY);
    const layout = buildPanelLayout(visibility, thresholds, { session: 300, investigation: 500 });
    expect(layout.sessionListWidth).toBe(300);
    expect(layout.investigationWidth).toBe(500);
  });

  it('sets investigationPresentation to drawer when Investigation is not docked', () => {
    const { visibility, thresholds } = computePanelVisibility(1280, MEASURED, null, DEFAULT_PANEL_VISIBILITY);
    const layout = buildPanelLayout(visibility, thresholds, {});
    expect(layout.investigationPresentation).toBe('drawer');
  });
});
