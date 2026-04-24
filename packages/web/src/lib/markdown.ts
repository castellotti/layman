import remarkGfm from 'remark-gfm';

export const REMARK_PLUGINS = [remarkGfm];

export const MARKDOWN_PROSE = `text-xs text-[#e6edf3] leading-relaxed prose prose-invert prose-xs max-w-none
  [&_p]:my-1 [&_p]:leading-relaxed
  [&_strong]:text-[#e6edf3] [&_strong]:font-semibold
  [&_em]:text-[#8b949e]
  [&_code]:text-[#79c0ff] [&_code]:bg-[#0d1117] [&_code]:px-1 [&_code]:rounded [&_code]:text-[11px]
  [&_pre]:bg-[#0d1117] [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto
  [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1
  [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:my-1
  [&_li]:my-0.5
  [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold
  [&_blockquote]:border-l-2 [&_blockquote]:border-[#30363d] [&_blockquote]:pl-2 [&_blockquote]:text-[#8b949e]
  [&_hr]:border-[#30363d] [&_hr]:my-3
  [&_table]:w-full [&_table]:border-collapse [&_table]:my-2
  [&_th]:border [&_th]:border-[#30363d] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_th]:bg-[#161b22]
  [&_td]:border [&_td]:border-[#30363d] [&_td]:px-2 [&_td]:py-1`.replace(/\s+/g, ' ').trim();

/**
 * Detects whether a string contains meaningful markdown formatting.
 * Returns true if the text has headers, lists, bold/italic, code blocks,
 * or other markdown constructs that warrant rendering.
 */
export function isMarkdown(text: string): boolean {
  if (!text || text.length < 4) return false;

  const patterns = [
    /^#{1,6}\s+\S/m,               // ATX headers: # Heading
    /^\s*[-*+]\s+\S/m,             // Unordered lists
    /^\s*\d+\.\s+\S/m,             // Ordered lists
    /\*\*[^*\n]+\*\*/,             // Bold **text**
    /\*[^*\n]+\*/,                 // Italic *text*
    /__[^_\n]+__/,                 // Bold __text__
    /_[^_\n]+_/,                   // Italic _text_
    /`[^`\n]+`/,                   // Inline code
    /^```/m,                       // Fenced code block
    /^\s*>/m,                      // Blockquote
    /\[.+\]\(.+\)/,               // Links [text](url)
    /^\s*[-*_]{3,}\s*$/m,         // Horizontal rule
    /\|.+\|.+\|/,                 // Table rows
  ];

  return patterns.some((re) => re.test(text));
}