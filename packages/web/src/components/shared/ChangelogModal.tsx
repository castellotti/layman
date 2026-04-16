import React, { useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { useChangelog, HARNESS_DISPLAY_NAMES } from '../../hooks/useChangelog.js';

const MARKDOWN_PROSE = `text-xs text-[#e6edf3] leading-relaxed prose prose-invert prose-xs max-w-none
  [&_p]:my-1 [&_p]:leading-relaxed
  [&_strong]:text-[#e6edf3] [&_strong]:font-semibold
  [&_em]:text-[#8b949e]
  [&_code]:text-[#79c0ff] [&_code]:bg-[#0d1117] [&_code]:px-1 [&_code]:rounded [&_code]:text-[11px]
  [&_pre]:bg-[#0d1117] [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto
  [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1
  [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:my-1
  [&_li]:my-0.5
  [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold
  [&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-[#58a6ff] [&_h2]:border-b [&_h2]:border-[#21262d] [&_h2]:pb-1
  [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-[#e6edf3]
  [&_hr]:border-[#21262d] [&_hr]:my-4
  [&_blockquote]:border-l-2 [&_blockquote]:border-[#30363d] [&_blockquote]:pl-2 [&_blockquote]:text-[#8b949e]`.replace(/\s+/g, ' ').trim();

interface ChangelogModalProps {
  agentType: string;
  activeVersion?: string;
  onClose: () => void;
}

/** Extract version string from heading text. Handles formats like:
 *  "## [2.1.92] - 2024-01-01", "## v2.1.92", "## 2.1.92 — 2024-01-01", "## 2.1.92" */
function extractVersion(heading: string): string | null {
  const m = heading.match(/v?(\d+\.\d+[\w.-]*)/);
  return m ? m[1] : null;
}

function scrollToVersion(container: HTMLElement, version: string) {
  const headings = container.querySelectorAll('h2');
  for (const h of headings) {
    if (extractVersion(h.textContent ?? '') === version) {
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
  }
  return false;
}

function getLatestVersion(container: HTMLElement): string | null {
  const first = container.querySelector('h2');
  if (!first) return null;
  return extractVersion(first.textContent ?? '');
}

export function ChangelogModal({ agentType, activeVersion, onClose }: ChangelogModalProps) {
  const { loading, markdown, sourceUrl, error } = useChangelog(agentType);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrolledRef = useRef(false);
  const displayName = HARNESS_DISPLAY_NAMES[agentType] ?? agentType;

  // Scroll to active version after markdown first renders. Guard with scrolledRef so
  // re-renders (e.g. from cached markdown delivered on a second open) don't re-scroll.
  useEffect(() => {
    if (scrolledRef.current || !markdown || !contentRef.current || !activeVersion) return;
    const container = contentRef.current;
    const id = setTimeout(() => {
      const latestVersion = getLatestVersion(container);
      // Only scroll away from top if the active version is not the latest
      if (latestVersion && latestVersion !== activeVersion) {
        scrollToVersion(container, activeVersion);
      }
      scrolledRef.current = true;
    }, 50);
    return () => clearTimeout(id);
  }, [markdown, activeVersion]);

  // Close on Escape
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );
  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-[#0d1117] border border-[#30363d] rounded-lg shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d] shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-[#e6edf3]">
              {displayName} Changelog
              {activeVersion && (
                <span className="ml-2 text-[10px] font-mono text-[#484f58] font-normal">
                  v{activeVersion} active
                </span>
              )}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            {sourceUrl && (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-[#58a6ff] hover:text-[#79c0ff] transition-colors flex items-center gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                View on GitHub
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z" />
                </svg>
              </a>
            )}
            <button
              onClick={onClose}
              className="text-[#8b949e] hover:text-[#e6edf3] transition-colors text-lg leading-none"
            >
              ×
            </button>
          </div>
        </div>

        {/* Content */}
        <div ref={contentRef} className="flex-1 overflow-y-auto p-5">
          {loading && (
            <div className="flex items-center justify-center py-12 text-[#484f58] text-xs">
              Loading changelog…
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center py-12 text-[#f85149] text-xs">
              Failed to load changelog: {error}
            </div>
          )}
          {markdown && !loading && (
            <div className={MARKDOWN_PROSE}>
              <ReactMarkdown>{markdown}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
