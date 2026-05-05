import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { MARKDOWN_PROSE, REMARK_PLUGINS } from '../../lib/markdown.js';

export function ThinkingBlock({ thinking }: { thinking: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-[#6e40c9]/30 overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-3 py-1 bg-[#161b22] hover:bg-[#1c2128] transition-colors"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span className="text-[10px] text-[#8957e5] font-mono uppercase">Thinking {open ? '▲' : '▼'}</span>
        <span className="text-[10px] text-[#484f58]">{thinking.length} chars</span>
      </button>
      {open && (
        <div className={`p-3 border-l-2 border-[#6e40c9]/50 max-h-64 overflow-y-auto text-[#8b949e] ${MARKDOWN_PROSE}`}>
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{thinking}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
