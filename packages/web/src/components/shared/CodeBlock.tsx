import React, { useState } from 'react';

interface CodeBlockProps {
  code: string;
  language?: string;
  maxLines?: number;
  className?: string;
  showWrapToggle?: boolean;
  defaultWrapped?: boolean;
}

export function CodeBlock({ code, language = 'text', maxLines, className = '', showWrapToggle = false, defaultWrapped = false }: CodeBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [wrapped, setWrapped] = useState(defaultWrapped);
  const [copied, setCopied] = useState(false);

  const lines = code.split('\n');
  const isLong = maxLines !== undefined && lines.length > maxLines;
  const displayCode = isLong && !expanded ? lines.slice(0, maxLines).join('\n') + '\n...' : code;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`relative rounded-md bg-[#0d1117] border border-[#30363d] overflow-hidden ${className}`}>
      {(language !== 'text' || showWrapToggle) && (
        <div className="flex items-center justify-between px-3 py-1 bg-[#161b22] border-b border-[#30363d]">
          <span className="text-xs text-[#8b949e] font-mono">{language !== 'text' ? language : ''}</span>
          <div className="flex items-center gap-2">
            {showWrapToggle && (
              <button
                onClick={(e) => { e.stopPropagation(); setWrapped((v) => !v); }}
                className={`text-xs transition-colors ${wrapped ? 'text-[#58a6ff]' : 'text-[#8b949e] hover:text-[#e6edf3]'}`}
                title={wrapped ? 'Disable line wrap' : 'Enable line wrap'}
              >
                ↵
              </button>
            )}
            <button
              onClick={handleCopy}
              className="text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors"
              title="Copy to clipboard"
            >
              {copied ? '✓' : 'Copy'}
            </button>
          </div>
        </div>
      )}
      <pre className={`p-3 text-xs font-mono text-[#e6edf3] leading-relaxed ${wrapped ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto'}`}>
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
