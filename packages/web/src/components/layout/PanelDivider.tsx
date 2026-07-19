import React, { useCallback, useRef } from 'react';

interface PanelDividerProps {
  /** Current width of the panel this divider resizes. */
  value: number;
  min: number;
  max: number;
  /** +1 if dragging right grows `value`, -1 if dragging right shrinks it. */
  direction: 1 | -1;
  onChange: (next: number) => void;
  title?: string;
}

const STEP = 16;

/**
 * Generic 6px drag-to-resize handle between two panels. Clamps to [min, max],
 * supports arrow-key resizing for accessibility, and disables text selection
 * on the page for the duration of the drag.
 */
export function PanelDivider({ value, min, max, direction, onChange, title }: PanelDividerProps) {
  const dragState = useRef<{ startX: number; startValue: number } | null>(null);

  const clamp = useCallback((n: number) => Math.max(min, Math.min(max, n)), [min, max]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragState.current = { startX: e.clientX, startValue: value };
      document.body.style.userSelect = 'none';

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!dragState.current) return;
        const delta = (moveEvent.clientX - dragState.current.startX) * direction;
        onChange(clamp(dragState.current.startValue + delta));
      };
      const onMouseUp = () => {
        dragState.current = null;
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [value, direction, onChange, clamp]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onChange(clamp(value - STEP * direction));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onChange(clamp(value + STEP * direction));
      }
    },
    [value, direction, onChange, clamp]
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      title={title}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      data-print-hide
      style={{
        width: 6,
        flexShrink: 0,
        cursor: 'col-resize',
        background: 'var(--bg-raised)',
        borderLeft: '1px solid var(--border)',
        borderRight: '1px solid var(--border)',
        transition: 'background 0.12s',
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'rgba(90,156,248,0.4)')}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--bg-raised)')}
    />
  );
}
