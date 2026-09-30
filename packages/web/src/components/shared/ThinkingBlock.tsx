import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { MARKDOWN_PROSE, REMARK_PLUGINS } from '../../lib/markdown.js';

export function ThinkingBlock({ thinking }: { thinking: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-[color-mix(in_srgb,var(--thinking)_30%,transparent)] overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-3 py-1 bg-[var(--bg-card)] hover:bg-[var(--bg-selected)] transition-colors"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span className="text-[10px] text-[var(--thinking)] font-mono uppercase">Thinking {open ? '▲' : '▼'}</span>
        <span className="text-[10px] text-[var(--text-faint)]">{thinking.length} chars</span>
      </button>
      {open && (
        <div className={`p-3 border-l-2 border-[color-mix(in_srgb,var(--thinking)_50%,transparent)] max-h-64 overflow-y-auto text-[var(--text-muted)] ${MARKDOWN_PROSE}`}>
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{thinking}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
