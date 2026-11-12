import React, { useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const REMARK_PLUGINS = [remarkGfm];
import { useChangelog, HARNESS_DISPLAY_NAMES } from '../../hooks/useChangelog.js';
import { scrollBehavior } from '../../lib/theme-runtime.js';

const MARKDOWN_PROSE = `text-xs text-text leading-relaxed prose prose-invert prose-xs max-w-none
  [&_p]:my-1 [&_p]:leading-relaxed
  [&_strong]:text-text [&_strong]:font-semibold
  [&_em]:text-text-muted
  [&_code]:text-info [&_code]:bg-bg [&_code]:px-1 [&_code]:rounded [&_code]:text-[11px]
  [&_pre]:bg-bg [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto
  [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1
  [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:my-1
  [&_li]:my-0.5
  [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold
  [&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-info [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-1
  [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-text
  [&_hr]:border-border [&_hr]:my-4
  [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-2 [&_blockquote]:text-text-muted
  [&_table]:w-full [&_table]:border-collapse [&_table]:my-2
  [&_th]:border [&_th]:border-border-strong [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_th]:bg-bg-card
  [&_td]:border [&_td]:border-border-strong [&_td]:px-2 [&_td]:py-1`.replace(/\s+/g, ' ').trim();

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
      h.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
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

  // Scroll to the active version after markdown first renders. Guard with scrolledRef so
  // cached markdown re-delivered on a second open doesn't re-scroll.
  // rAF ensures the DOM has painted before we query headings.
  useEffect(() => {
    if (scrolledRef.current || !markdown || !contentRef.current || !activeVersion) return;
    const container = contentRef.current;
    const id = requestAnimationFrame(() => {
      const latestVersion = getLatestVersion(container);
      if (latestVersion && latestVersion !== activeVersion) {
        scrollToVersion(container, activeVersion);
      }
      scrolledRef.current = true;
    });
    return () => cancelAnimationFrame(id);
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
        className="bg-bg border border-border-strong rounded-lg shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-strong shrink-0">
          <h2 className="text-sm font-semibold text-text">
            {displayName} Changelog
            {activeVersion && (
              <span className="ml-2 text-[10px] font-mono text-text-faint font-normal">
                v{activeVersion} active
              </span>
            )}
          </h2>
          <div className="flex items-center gap-3">
            {sourceUrl && (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-info hover:text-text transition-colors flex items-center gap-1"
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
              className="text-text-muted hover:text-text transition-colors text-lg leading-none"
            >
              ×
            </button>
          </div>
        </div>

        <div ref={contentRef} className="flex-1 overflow-y-auto p-5">
          {loading && (
            <div className="flex items-center justify-center py-12 text-text-faint text-xs">
              Loading changelog…
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center py-12 text-error text-xs">
              Failed to load changelog: {error}
            </div>
          )}
          {markdown && !loading && (
            <div className={MARKDOWN_PROSE}>
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{markdown}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
