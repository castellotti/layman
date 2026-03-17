import React, { useState } from 'react';

interface CodeBlockProps {
  code: string;
  language?: string;
  maxLines?: number;
  className?: string;
}

export function CodeBlock({ code, language = 'text', maxLines, className = '' }: CodeBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const lines = code.split('\n');
  const isLong = maxLines !== undefined && lines.length > maxLines;
  const displayCode = isLong && !expanded ? lines.slice(0, maxLines).join('\n') + '\n...' : code;

  return (
    <div className={`relative rounded-md bg-[#0d1117] border border-[#30363d] overflow-hidden ${className}`}>
      {language !== 'text' && (
        <div className="flex items-center justify-between px-3 py-1 bg-[#161b22] border-b border-[#30363d]">
          <span className="text-xs text-[#8b949e] font-mono">{language}</span>
          <button
            onClick={() => navigator.clipboard.writeText(code).catch(() => {})}
            className="text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors"
          >
            Copy
          </button>
        </div>
      )}
      <pre className="p-3 overflow-x-auto text-xs font-mono text-[#e6edf3] leading-relaxed">
        <code>{displayCode}</code>
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full py-1.5 text-xs text-[#58a6ff] hover:text-[#79c0ff] bg-[#161b22] border-t border-[#30363d] transition-colors"
        >
          {expanded ? 'Show less' : `Show ${lines.length - maxLines!} more lines`}
        </button>
      )}
    </div>
  );
}
