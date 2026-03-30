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