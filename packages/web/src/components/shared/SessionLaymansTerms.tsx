import React, { useState, useRef, useEffect } from 'react';

export interface SummaryEntry {
  summary: string;
  generatedAt: number;
}

interface SessionLaymansTermsProps {
  summary: string | null;
  summaryHistory: SummaryEntry[];
  summaryError: string | null;
  isSummarizing: boolean;
  onGenerate: () => void;
  onClearError?: () => void;
  /** Extra classes applied to the wrapper div */
  className?: string;
  /** Tooltip opens upward instead of downward (for use inside panels) */
  tooltipUp?: boolean;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function SessionLaymansTerms({
  summary,
  summaryHistory,
  summaryError,
  isSummarizing,
  onGenerate,
  onClearError,
  className,
  tooltipUp = false,
}: SessionLaymansTermsProps) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-clear error after 5s
  useEffect(() => {
    if (!summaryError) return;
    if (errorClearTimer.current) clearTimeout(errorClearTimer.current);
    errorClearTimer.current = setTimeout(() => {
      onClearError?.();
    }, 5000);
    return () => { if (errorClearTimer.current) clearTimeout(errorClearTimer.current); };
  }, [summaryError, onClearError]);

  const handleMouseEnter = () => {
    hoverTimer.current = setTimeout(() => setTooltipOpen(true), 300);
  };

  const handleMouseLeave = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setTooltipOpen(false);
  };

  const tooltipPositionClass = tooltipUp
    ? 'bottom-full mb-2'
    : 'top-full mt-2';

  return (
    <div
      className={`relative flex items-center ${className ?? ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        onClick={onGenerate}
        disabled={isSummarizing}
        className={`truncate text-xs transition-colors disabled:cursor-not-allowed text-left ${
          isSummarizing
            ? 'text-[#8b949e] animate-pulse cursor-not-allowed'
            : summaryError
              ? 'text-[#f85149] hover:text-[#ff7b72] cursor-pointer'
              : 'text-[#8b949e] hover:text-[#e6edf3] cursor-pointer'
        }`}
      >
        {isSummarizing
          ? 'Summarizing...'
          : summaryError
            ? `⚠ ${summaryError}`
            : (summary ?? "Layman's Terms")}
      </button>

      {/* Tooltip */}
      {tooltipOpen && !isSummarizing && (
        <div className={`absolute left-1/2 -translate-x-1/2 ${tooltipPositionClass} z-50 w-96 max-w-[90vw] bg-[#1c2128] border border-[#30363d] rounded-lg shadow-2xl p-3 space-y-2 text-left pointer-events-none`}>
          {summaryHistory.length === 0 ? (
            <>
              <p className="text-[11px] font-semibold text-[#e6edf3]">Layman&apos;s Terms</p>
              <p className="text-[11px] text-[#8b949e] leading-relaxed">
                Generates a plain-English summary of what the AI agent has been doing during this session — written for someone with no technical background. Click to generate your first summary.
              </p>
            </>
          ) : (
            <>
              <p className="text-[11px] font-semibold text-[#e6edf3]">Layman&apos;s Terms — latest</p>
              <p className="text-[11px] text-[#e6edf3] leading-relaxed whitespace-pre-wrap">
                {summaryHistory[summaryHistory.length - 1].summary}
              </p>
              {summaryHistory.length > 1 && (
                <div className="border-t border-[#30363d] pt-2 space-y-2">
                  <p className="text-[10px] text-[#484f58] uppercase tracking-wider font-medium">Previous generations</p>
                  {[...summaryHistory].slice(0, -1).reverse().map((h, i) => (
                    <div key={i} className="space-y-0.5">
                      <p className="text-[9px] text-[#484f58]">{formatTime(h.generatedAt)}</p>
                      <p className="text-[10px] text-[#8b949e] leading-relaxed line-clamp-3 whitespace-pre-wrap">{h.summary}</p>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[9px] text-[#484f58] border-t border-[#30363d] pt-1">
                Generated {formatTime(summaryHistory[summaryHistory.length - 1].generatedAt)} · Click to regenerate
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
