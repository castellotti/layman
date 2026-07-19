import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useSessionStore, type PinnedView, type SplitOverrides } from '../stores/sessionStore.js';
import { eventDetail } from '../lib/event-styles.js';
import type { TimelineEvent } from '../lib/types.js';

// ─── Constants (§1.1 / §2.2) ────────────────────────────────────────────────

export const LOGS_MIN = 640;
export const INVEST_W = 480;
export const TIMESTAMP_MARGIN_FACTOR = 2;
/** Total dead-zone width around each threshold; half is applied on each side. */
export const HYSTERESIS = 50;

const SAMPLE_TIMESTAMP = '22:46:32';
const ROW_MONO_FONT = '10px "IBM Plex Mono", monospace';
// agent_response/user_prompt rows can be arbitrarily long prose (unlike tool commands
// or file paths); measuring their full length would make the docking threshold
// unreachable in practice. Cap what's *measured* for threshold purposes only — the
// row still renders and copies its full, untruncated text (§1.1: never bake '…' into
// the summary string itself).
const MAX_MEASURED_CHARS = 220;

export interface MeasuredWidths {
  maxText: number;
  timeW: number;
}

const FALLBACK_MEASURED: MeasuredWidths = { maxText: 720, timeW: 48 };

export interface PanelVisibility {
  showDashboard: boolean;
  showLogs: boolean;
  showInvestigation: boolean;
}

export interface PanelThresholds {
  sessionDefault: number;
  dashNeeded: number;
  logsAt: number;
  investAt: number;
}

export interface PanelLayout extends PanelVisibility {
  investigationPresentation: 'docked' | 'drawer';
  dashboardWidth: number;
  sessionListWidth: number;
  investigationWidth: number;
  logsDockThreshold: number;
  viewportWidth: number;
}

export const DEFAULT_PANEL_VISIBILITY: PanelVisibility = {
  showDashboard: true,
  showLogs: false,
  showInvestigation: false,
};

// ─── Pure, unit-testable core ───────────────────────────────────────────────

/**
 * Content-driven thresholds (§1.1 formula). Always derived from the DEFAULT
 * session-list width — never from a divider override — so dragging a divider
 * can never hide a panel and re-trigger the override-reset feedback loop.
 */
export function computeThresholds(measured: MeasuredWidths, viewportWidth: number): PanelThresholds {
  const sessionDefault = Math.max(250, Math.min(360, Math.round(viewportWidth * 0.16)));
  // row chrome: pad(16) + num(30)+gap(6) + kind(68)+gap(6) + text + gap(6) + time + margin(2×time) + pad(16)
  const previewNeed =
    16 + 30 + 6 + 68 + 6 + measured.maxText + 6 + measured.timeW + TIMESTAMP_MARGIN_FACTOR * measured.timeW + 16;
  const dashNeeded = sessionDefault + 6 + previewNeed;
  const logsAt = dashNeeded + LOGS_MIN;
  const investAt = logsAt + INVEST_W + 420;
  return { sessionDefault, dashNeeded, logsAt, investAt };
}

function withHysteresis(raw: boolean, prev: boolean, width: number, threshold: number, band: number): boolean {
  if (raw === prev) return raw;
  if (Math.abs(width - threshold) < band) return prev;
  return raw;
}

/**
 * Computes panel visibility for a given viewport width. Honors pinnedView
 * (pinning a single view hides everything else, including the Investigation
 * dock — Investigate then opens as a drawer) and applies hysteresis around
 * each threshold so panels don't flicker when the width sits near a boundary.
 */
export function computePanelVisibility(
  width: number,
  measured: MeasuredWidths,
  pinnedView: PinnedView,
  prev: PanelVisibility,
  hysteresisBand: number = HYSTERESIS / 2
): { visibility: PanelVisibility; thresholds: PanelThresholds } {
  const thresholds = computeThresholds(measured, width);

  let showDashboard: boolean;
  let showLogs: boolean;
  if (pinnedView === 'dashboard') {
    showDashboard = true;
    showLogs = false;
  } else if (pinnedView === 'stream') {
    showDashboard = false;
    showLogs = true;
  } else {
    showDashboard = true;
    showLogs = withHysteresis(width >= thresholds.logsAt, prev.showLogs, width, thresholds.logsAt, hysteresisBand);
  }

  const showInvestigation = pinnedView
    ? false
    : withHysteresis(
        showLogs && width >= thresholds.investAt,
        prev.showInvestigation,
        width,
        thresholds.investAt,
        hysteresisBand
      );

  return { visibility: { showDashboard, showLogs, showInvestigation }, thresholds };
}

export function panelSetKey(v: PanelVisibility): string {
  return `${v.showDashboard ? 1 : 0}${v.showLogs ? 1 : 0}${v.showInvestigation ? 1 : 0}`;
}

export function buildPanelLayout(
  visibility: PanelVisibility,
  thresholds: PanelThresholds,
  splitOverrides: SplitOverrides
): PanelLayout {
  const sessionListWidth = splitOverrides.session ?? thresholds.sessionDefault;
  const dashboardWidth =
    splitOverrides.dashboard ?? thresholds.dashNeeded - thresholds.sessionDefault + sessionListWidth;
  const investigationWidth = splitOverrides.investigation ?? INVEST_W;

  return {
    ...visibility,
    investigationPresentation: visibility.showInvestigation ? 'docked' : 'drawer',
    dashboardWidth,
    sessionListWidth,
    investigationWidth,
    logsDockThreshold: thresholds.logsAt,
    viewportWidth: 0,
  };
}

// ─── Canvas measurement ──────────────────────────────────────────────────────

let measureCanvas: HTMLCanvasElement | null = null;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  return measureCanvas.getContext('2d');
}

export function measureRowWidths(events: TimelineEvent[]): MeasuredWidths {
  const ctx = getMeasureCtx();
  if (!ctx) return FALLBACK_MEASURED;
  ctx.font = ROW_MONO_FONT;
  let maxText = 0;
  for (const event of events) {
    const w = ctx.measureText(eventDetail(event).slice(0, MAX_MEASURED_CHARS)).width;
    if (w > maxText) maxText = w;
  }
  const timeW = ctx.measureText(SAMPLE_TIMESTAMP).width;
  return { maxText: Math.ceil(maxText), timeW: Math.ceil(timeW) };
}

// ─── React hook ──────────────────────────────────────────────────────────────

/**
 * Drives progressive panel disclosure for the expanding-interface layout.
 * Observes `containerRef` (the panels row) with a ResizeObserver, measures the
 * widest event row with canvas measureText (re-measuring on font load and when
 * the event set changes), and pushes the resulting PanelLayout to the store so
 * non-descendant consumers (Header) can read it too.
 */
export function useExpandingLayout(
  containerRef: RefObject<HTMLElement | null>,
  events: TimelineEvent[]
): PanelLayout {
  const pinnedView = useSessionStore((s) => s.pinnedView);
  const splitOverrides = useSessionStore((s) => s.splitOverrides);

  const [width, setWidth] = useState(0);
  const [measured, setMeasured] = useState<MeasuredWidths>(FALLBACK_MEASURED);
  const visibilityRef = useRef<PanelVisibility>(DEFAULT_PANEL_VISIBILITY);
  const prevSetKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [containerRef]);

  const eventIdKey = useMemo(() => events.map((e) => e.id).join(','), [events]);
  useEffect(() => {
    setMeasured(measureRowWidths(events));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventIdKey]);
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts?.ready) return;
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) setMeasured(measureRowWidths(events));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { visibility, thresholds } = useMemo(
    () => computePanelVisibility(width, measured, pinnedView, visibilityRef.current),
    [width, measured, pinnedView]
  );
  visibilityRef.current = visibility;

  const layout = useMemo(
    () => ({ ...buildPanelLayout(visibility, thresholds, splitOverrides), viewportWidth: width }),
    [visibility, thresholds, splitOverrides, width]
  );

  // Reset divider overrides whenever the visible panel set changes (§1.2). Skipped
  // on the very first computation so mount doesn't clear a (nonexistent) override.
  useEffect(() => {
    const key = panelSetKey(visibility);
    const changed = prevSetKeyRef.current !== null && prevSetKeyRef.current !== key;
    prevSetKeyRef.current = key;
    if (changed) {
      useSessionStore.getState().resetSplitOverrides();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibility.showDashboard, visibility.showLogs, visibility.showInvestigation]);

  useEffect(() => {
    useSessionStore.getState().setPanelLayout(layout);
  }, [layout]);

  return layout;
}
