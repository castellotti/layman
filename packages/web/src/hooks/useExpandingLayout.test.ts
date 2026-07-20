import { describe, it, expect } from 'vitest';
import {
  computeThresholds,
  computePanelVisibility,
  panelSetKey,
  buildPanelLayout,
  DEFAULT_PANEL_VISIBILITY,
  LOGS_MIN,
  INVEST_W,
  type MeasuredWidths,
  type PanelOverrides,
} from './useExpandingLayout.js';

// Representative measured widths (roughly matches a mid-length Bash command row).
const MEASURED: MeasuredWidths = { maxText: 480, timeW: 48 };
const AUTO: PanelOverrides = { dashboard: null, logs: null };

describe('computeThresholds', () => {
  it('derives LOGS_AT/INVEST_AT strictly increasing and content-driven', () => {
    const t = computeThresholds(MEASURED, 1280);
    expect(t.logsAt).toBe(t.dashNeeded + LOGS_MIN);
    expect(t.investAt).toBe(t.logsAt + INVEST_W + 420);
    expect(t.logsAt).toBeGreaterThan(t.dashNeeded);
    expect(t.investAt).toBeGreaterThan(t.logsAt);
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

describe('computePanelVisibility — panel sets across representative viewports (auto)', () => {
  const cases: Array<[number, string]> = [
    [1280, 'laptop'],
    [2048, ''],
    [2560, ''],
    [3440, 'ultrawide'],
    [5120, '5K2K'],
  ];

  for (const [width, label] of cases) {
    it(`computes a visibility set for ${width}px ${label}`, () => {
      const { visibility, thresholds } = computePanelVisibility(width, MEASURED, AUTO, DEFAULT_PANEL_VISIBILITY);
      expect(visibility.showDashboard).toBe(true);
      expect(visibility.showLogs).toBe(width >= thresholds.logsAt);
      if (!visibility.showLogs) {
        expect(visibility.showInvestigation).toBe(false);
      }
    });
  }

  it('a narrow 1280px laptop shows Dashboard only', () => {
    const { visibility } = computePanelVisibility(1280, MEASURED, AUTO, DEFAULT_PANEL_VISIBILITY);
    expect(visibility).toEqual({ showDashboard: true, showLogs: false, showInvestigation: false });
  });

  it('a very wide 5120px viewport shows Dashboard, Logs, and Investigation', () => {
    const { visibility } = computePanelVisibility(5120, MEASURED, AUTO, DEFAULT_PANEL_VISIBILITY);
    expect(visibility).toEqual({ showDashboard: true, showLogs: true, showInvestigation: true });
  });
});

describe('computePanelVisibility — explicit overrides', () => {
  it('forcing Dashboard off shows Logs-only regardless of width', () => {
    const { visibility } = computePanelVisibility(5120, MEASURED, { dashboard: false, logs: null }, DEFAULT_PANEL_VISIBILITY);
    expect(visibility.showDashboard).toBe(false);
    expect(visibility.showLogs).toBe(true);
  });

  it('forcing Logs off at a wide width still hides it', () => {
    const { visibility } = computePanelVisibility(5120, MEASURED, { dashboard: null, logs: false }, DEFAULT_PANEL_VISIBILITY);
    expect(visibility.showDashboard).toBe(true);
    expect(visibility.showLogs).toBe(false);
    expect(visibility.showInvestigation).toBe(false);
  });

  it('forcing both on shows both even at a narrow width', () => {
    const { visibility } = computePanelVisibility(1280, MEASURED, { dashboard: true, logs: true }, DEFAULT_PANEL_VISIBILITY);
    expect(visibility.showDashboard).toBe(true);
    expect(visibility.showLogs).toBe(true);
  });

  it('forcing Dashboard off and Logs on is the "Dashboard row -> Logs-only" scenario', () => {
    const { visibility } = computePanelVisibility(1280, MEASURED, { dashboard: false, logs: true }, DEFAULT_PANEL_VISIBILITY);
    expect(visibility).toEqual({ showDashboard: false, showLogs: true, showInvestigation: false });
  });
});

describe('computePanelVisibility — hysteresis', () => {
  // A wide measured row pushes logsAt past 2250px, where sessionDefault is clamped flat
  // at its 360px ceiling — so the threshold itself stays stable across the small width
  // deltas exercised below (unlike near the unclamped, linearly-scaling region).
  const WIDE: MeasuredWidths = { maxText: 1200, timeW: 48 };

  it('does not flip Logs visibility for a small width change straddling the threshold', () => {
    const { thresholds } = computePanelVisibility(3000, WIDE, AUTO, DEFAULT_PANEL_VISIBILITY);
    expect(thresholds.sessionDefault).toBe(360); // sanity: confirms we're in the clamped region
    const justBelow = thresholds.logsAt - 1;
    const justAbove = thresholds.logsAt + 1;

    // Starting hidden, a width just above the threshold but within the dead zone stays hidden.
    const stillHidden = computePanelVisibility(justAbove, WIDE, AUTO, { ...DEFAULT_PANEL_VISIBILITY, showLogs: false });
    expect(stillHidden.visibility.showLogs).toBe(false);

    // Starting shown, a width just below the threshold but within the dead zone stays shown.
    const stillShown = computePanelVisibility(justBelow, WIDE, AUTO, { ...DEFAULT_PANEL_VISIBILITY, showLogs: true });
    expect(stillShown.visibility.showLogs).toBe(true);
  });

  it('flips once the width clears the hysteresis band', () => {
    const { thresholds } = computePanelVisibility(3000, WIDE, AUTO, DEFAULT_PANEL_VISIBILITY);
    const farAbove = thresholds.logsAt + 40;
    const result = computePanelVisibility(farAbove, WIDE, AUTO, { ...DEFAULT_PANEL_VISIBILITY, showLogs: false });
    expect(result.visibility.showLogs).toBe(true);
  });
});

describe('panelSetKey', () => {
  it('produces a stable, distinguishing key per visibility combination', () => {
    expect(panelSetKey({ showDashboard: true, showLogs: false, showInvestigation: false })).toBe('100');
    expect(panelSetKey({ showDashboard: true, showLogs: true, showInvestigation: true })).toBe('111');
  });
});

describe('buildPanelLayout', () => {
  it('uses defaults when no split overrides are present', () => {
    const { visibility, thresholds } = computePanelVisibility(3440, MEASURED, AUTO, DEFAULT_PANEL_VISIBILITY);
    const layout = buildPanelLayout(visibility, thresholds, {});
    expect(layout.sessionListWidth).toBe(thresholds.sessionDefault);
    expect(layout.investigationWidth).toBe(INVEST_W);
  });

  it('applies split overrides without touching the underlying thresholds', () => {
    const { visibility, thresholds } = computePanelVisibility(3440, MEASURED, AUTO, DEFAULT_PANEL_VISIBILITY);
    const layout = buildPanelLayout(visibility, thresholds, { session: 300, investigation: 500 });
    expect(layout.sessionListWidth).toBe(300);
    expect(layout.investigationWidth).toBe(500);
  });

  it('sets investigationPresentation to drawer when Investigation is not docked', () => {
    const { visibility, thresholds } = computePanelVisibility(1280, MEASURED, AUTO, DEFAULT_PANEL_VISIBILITY);
    const layout = buildPanelLayout(visibility, thresholds, {});
    expect(layout.investigationPresentation).toBe('drawer');
  });
});
