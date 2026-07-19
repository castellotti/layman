import React, { useState } from 'react';
import { splitCommandLines, hasSudoLine, copyAllPayload, copyLinePayload } from '../../lib/command-lines.js';

interface CommandBlockProps {
  code: string;
  className?: string;
}

function CopyIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="5" y="5" width="8" height="8" rx="1.5" />
      <path d="M11 5V4a1.5 1.5 0 0 0-1.5-1.5h-5A1.5 1.5 0 0 0 3 4v5A1.5 1.5 0 0 0 4.5 10.5H5" />
    </svg>
  );
}

/**
 * Shell command block for detail cards — copy-all, per-line copy (so a user can
 * grab one `sudo` line into a terminal), and a header notice when sudo is
 * detected. Lines are copied verbatim (source text), never the rendered DOM.
 */
export function CommandBlock({ code, className = '' }: CommandBlockProps) {
  const lines = splitCommandLines(code);
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedLine, setCopiedLine] = useState<number | null>(null);
  const [hoveredLine, setHoveredLine] = useState<number | null>(null);
  const hasSudo = hasSudoLine(lines);

  const copyAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(copyAllPayload(lines)).catch(() => {});
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1500);
  };

  const copyLine = (e: React.MouseEvent, i: number) => {
    e.stopPropagation();
    navigator.clipboard.writeText(copyLinePayload(lines, i)).catch(() => {});
    setCopiedLine(i);
    setTimeout(() => setCopiedLine((cur) => (cur === i ? null : cur)), 1500);
  };

  return (
    <div className={className} style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 10px', background: 'var(--bg-card)', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)' }}>
          shell{hasSudo ? ' · run in your terminal (requires sudo)' : ''}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={copyAll}
          style={{ fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
        >
          {copiedAll ? '✓ Copied' : 'Copy all'}
        </button>
      </div>
      <div style={{ padding: '6px 0' }}>
        {lines.map((line, i) => (
          <div
            key={i}
            onMouseEnter={() => setHoveredLine(i)}
            onMouseLeave={() => setHoveredLine((cur) => (cur === i ? null : cur))}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '1px 10px',
              background: hoveredLine === i ? 'var(--bg-selected)' : 'transparent',
            }}
          >
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.8, color: 'var(--info)',
              flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {line}
            </span>
            <button
              onClick={(e) => copyLine(e, i)}
              title="Copy this line"
              style={{
                display: 'flex', alignItems: 'center', gap: 3, fontSize: 9.5,
                color: copiedLine === i ? 'var(--ok)' : 'var(--text-faint)',
                background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', flexShrink: 0,
                opacity: hoveredLine === i || copiedLine === i ? 1 : 0,
                transition: 'opacity 0.1s',
              }}
              onMouseEnter={(e) => { if (copiedLine !== i) e.currentTarget.style.color = 'var(--text)'; }}
              onMouseLeave={(e) => { if (copiedLine !== i) e.currentTarget.style.color = 'var(--text-faint)'; }}
            >
              <CopyIcon />
              {copiedLine === i ? 'Copied' : ''}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
