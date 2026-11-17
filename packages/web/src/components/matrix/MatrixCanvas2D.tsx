import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { MatrixRow } from '../../lib/matrix-feed.js';
import { hash01, headRow, planStreams, type Stream } from '../../lib/matrix-rain.js';
import { motionIsFull, readToken } from '../../lib/theme-runtime.js';
import { useThemeVersion } from '../../hooks/useThemeVersion.js';
import { useElementSize } from '../../hooks/useElementSize.js';
import { StreamCard, TopList, type Hover } from './StreamCard.js';

/** A cell, in CSS px at the Compact design; the canvas is not scaled by density. */
const CELL_W = 14;
const CELL_H = 18;
const FONT_PX = 15;
/** The simulation's step. Between steps a frame does nothing. */
const TICK_MS = 50;
const FADE_ALPHA = 0.1;
const FILLER_GLYPHS = '0123456789ABCDEFZ:.=*+-<>|';
/** Blank rows between one fall of an address and its repeat in the same stream. */
const REPEAT_GAP = 4;

interface Colours { bg: string; text: string; ok: string; error: string; warn: string; hot: string; font: string }

function readColours(): Colours {
  return {
    bg: readToken('bg'), text: readToken('text'), ok: readToken('ok'), error: readToken('error'),
    warn: readToken('warn'), hot: readToken('accent-hot'), font: readToken('font-mono') || 'monospace',
  };
}

interface Filler { head: number; speed: number; startAt: number; last: number }

/**
 * The Matrix 2D renderer: monospace columns of falling text on one canvas. A fixed 50 ms step fades the
 * whole canvas a little (which draws every trail, with no per-glyph bookkeeping) and draws only each
 * stream's new head cell, so a tick costs by the columns, not the cells. What falls is `planStreams`;
 * this only paints it. Colours are read once per theme (`useThemeVersion`). Under reduced or no motion it
 * draws one still frame and redraws only when the data, size or theme changes.
 */
export function MatrixCanvas2D({ rows, ready, resetKey, gloveToken, onOpenNetwork }: {
  rows: MatrixRow[];
  /** The rows are the answer for `resetKey`, not a placeholder while it loads. */
  ready: boolean;
  /** Session and window: a change of either forgets what is falling and what is known. */
  resetKey: string;
  /** The glove session this is, when it is one: the card then offers Network. */
  gloveToken: string | null;
  onOpenNetwork: (token: string, address: string) => void;
}) {
  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const themeVersion = useThemeVersion();
  const [hover, setHover] = useState<Hover | null>(null);

  const rowsRef = useRef(rows);
  const readyRef = useRef(ready);
  const byAddress = useMemo(() => new Map(rows.map((r) => [r.address, r])), [rows]);
  const streams = useRef<Stream[]>([]);
  const lastColumn = useRef(new Map<string, number>());
  /** Null until the first plan after the rows' source changed: nothing is fresh then. */
  const known = useRef<Set<string> | null>(null);
  const fillers = useRef<Filler[]>([]);
  const drawnRow = useRef(new Map<Stream, number>());
  const replan = useRef<() => void>(() => {});
  const hoverRef = useRef<Hover | null>(null);
  hoverRef.current = hover;

  const cols = Math.max(0, Math.floor(box.width / CELL_W));
  const rowCount = Math.max(0, Math.floor(box.height / CELL_H));
  const full = motionIsFull();

  // New rows: plan at once, so a new address does not wait for the next tick.
  useEffect(() => {
    rowsRef.current = rows;
    readyRef.current = ready;
    replan.current();
  }, [rows, ready]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || cols === 0 || rowCount === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(cols * CELL_W * dpr);
    canvas.height = Math.floor(rowCount * CELL_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = readColours();
    ctx.font = `bold ${FONT_PX}px ${c.font}`;
    ctx.textBaseline = 'top';
    const clear = () => { ctx.globalAlpha = 1; ctx.fillStyle = c.bg; ctx.fillRect(0, 0, cols * CELL_W, rowCount * CELL_H); };
    clear();
    drawnRow.current = new Map();
    const toneColour = (s: Stream) => (s.tone === 'blocked' ? c.error : s.tone === 'untunnelled' ? c.warn : c.ok);

    const plan = (now: number) => {
      streams.current = planStreams({
        rows: rowsRef.current, columns: cols, visibleRows: rowCount, now,
        current: streams.current, lastColumn: lastColumn.current, known: known.current, rand: Math.random,
      });
      for (const s of streams.current) lastColumn.current.set(s.address, s.column);
      // What the screen has been given. Not before the answer is in, or its first rows would all be new.
      if (readyRef.current) known.current = new Set([...(known.current ?? []), ...rowsRef.current.map((r) => r.address)]);
    };

    const cell = (col: number, row: number, ch: string, colour: string, alpha: number) => {
      ctx.globalAlpha = 1;
      ctx.fillStyle = c.bg;
      ctx.fillRect(col * CELL_W, row * CELL_H, CELL_W, CELL_H);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = colour;
      ctx.fillText(ch, col * CELL_W + 1, row * CELL_H + 1);
    };

    if (!full) {
      // One still frame: each stream's text at a row from a hash of its address, drawn once.
      const stillPlan = () => {
        clear();
        plan(0);
        for (const s of streams.current) {
          const top = Math.floor(hash01(s.address) * Math.max(1, rowCount - s.text.length));
          for (let i = 0; i < s.text.length && top + i < rowCount; i++) {
            const last = i === s.text.length - 1;
            cell(s.column, top + i, s.text[i], last ? c.text : toneColour(s), last ? 1 : 0.35 + 0.5 * s.weight * (i / s.text.length));
          }
        }
      };
      replan.current = stillPlan;
      stillPlan();
      return () => { replan.current = () => {}; };
    }

    fillers.current = Array.from({ length: cols }, () => ({ head: -1, speed: 3 + Math.random() * 5, startAt: performance.now() + Math.random() * 6000, last: -1 }));
    let raf = 0;
    let lastTick = 0;

    const tick = (now: number) => {
      plan(now);
      // The trails: fade everything a little.
      ctx.globalAlpha = FADE_ALPHA;
      ctx.fillStyle = c.bg;
      ctx.fillRect(0, 0, cols * CELL_W, rowCount * CELL_H);
      // Filler: faint, slow, a random glyph at each column's head.
      for (let col = 0; col < cols; col++) {
        const f = fillers.current[col];
        if (now < f.startAt) continue;
        const row = Math.floor(((now - f.startAt) / 1000) * f.speed);
        if (row >= rowCount) {
          f.startAt = now + 1000 + Math.random() * 8000;
          f.speed = 3 + Math.random() * 5;
          f.last = -1;
          continue;
        }
        if (row !== f.last) {
          ctx.globalAlpha = 0.16;
          ctx.fillStyle = c.ok;
          ctx.fillText(FILLER_GLYPHS[Math.floor(Math.random() * FILLER_GLYPHS.length)], col * CELL_W + 1, row * CELL_H + 1);
          f.last = row;
        }
      }
      // Streams: only a head that entered a new row draws, and the cell above it steps down in brightness.
      for (const s of streams.current) {
        const row = Math.min(rowCount - 1, Math.floor(headRow(s, now)));
        const prev = drawnRow.current.get(s) ?? -1;
        if (row <= prev) continue;
        const trail = s.fresh ? c.hot : toneColour(s);
        const trailAlpha = 0.45 + 0.5 * s.weight;
        // The address repeats down a tall screen, with a gap so one does not run into the next.
        const ch = (r: number) => (r % (s.text.length + REPEAT_GAP) < s.text.length ? s.text[r % (s.text.length + REPEAT_GAP)] : ' ');
        // The old head steps down to trail, any rows skipped since are trail, the new head is brightest.
        if (prev >= 0) cell(s.column, prev, ch(prev), trail, trailAlpha);
        for (let r = prev + 1; r < row; r++) cell(s.column, r, ch(r), trail, trailAlpha);
        cell(s.column, row, ch(row), s.fresh ? c.hot : c.text, 1);
        drawnRow.current.set(s, row);
      }
      if (drawnRow.current.size > streams.current.length) {
        const live = new Set(streams.current);
        for (const s of drawnRow.current.keys()) if (!live.has(s)) drawnRow.current.delete(s);
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.visibilityState !== 'visible' || now - lastTick < TICK_MS) return;
      lastTick = now;
      tick(now);
    };
    replan.current = () => plan(performance.now());
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      replan.current = () => {};
    };
  }, [cols, rowCount, full, themeVersion]);

  // A new session or window: nothing on screen belongs to the last one.
  useEffect(() => {
    streams.current = [];
    known.current = null;
    lastColumn.current = new Map();
    drawnRow.current = new Map();
  }, [resetKey]);

  /** The stream under the pointer, with the pointer's place in the box. */
  const streamAt = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / CELL_W);
    return { s: streams.current.find((x) => x.column === col), x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (hoverRef.current?.pinned) return;
    const { s, x, y } = streamAt(e);
    if (!s) { if (hoverRef.current) setHover(null); return; }
    if (hoverRef.current?.address === s.address) return;
    setHover({ address: s.address, x, y, pinned: false });
  };
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const { s, x, y } = streamAt(e);
    if (!s || hover?.pinned) { setHover(null); return; }
    setHover({ address: s.address, x, y, pinned: true });
  };

  const card = hover ? byAddress.get(hover.address) : undefined;

  return (
    <div
      ref={boxRef}
      onPointerMove={onMove}
      onPointerLeave={() => { if (!hoverRef.current?.pinned) setHover(null); }}
      onClick={onClick}
      style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--bg)' }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${rows.length} destinations falling as text`}
        style={{ display: 'block', width: cols * CELL_W, height: rowCount * CELL_H }}
      />
      <TopList rows={rows} />
      {hover && card && <StreamCard hover={hover} row={card} box={box} gloveToken={gloveToken} onOpenNetwork={onOpenNetwork} />}
    </div>
  );
}
