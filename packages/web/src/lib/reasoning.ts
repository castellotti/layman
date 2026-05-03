/**
 * Client-side counterpart to filter.py's _extract_reasoning().
 * Strips reasoning/thinking HTML blocks from agent response text so that
 * summaries, tooltips, and card bodies show only the clean response.
 *
 * Handles events stored before the filter-side fix (where data.thinking is
 * absent and data.prompt contains raw <details type="reasoning"> or <think>
 * HTML).  New events have data.thinking set by the filter and data.prompt
 * already clean — this function is a no-op for those.
 */

const REASONING_PATTERNS: RegExp[] = [
  // <details type="reasoning" ...><summary>...</summary> ... </details>
  /<details[^>]*\btype=["']?reasoning["']?[^>]*>\s*<summary>[^<]*<\/summary>([\s\S]*?)<\/details>/gi,
  // <think>...</think>  (DeepSeek-R1 and similar)
  /<think>([\s\S]*?)<\/think>/gi,
  // <thinking>...</thinking>
  /<thinking>([\s\S]*?)<\/thinking>/gi,
];

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

export interface ExtractedReasoning {
  /** Extracted thinking text, or null if none found */
  thinking: string | null;
  /** Response text with all reasoning blocks removed */
  response: string;
}

/**
 * Extract reasoning blocks from raw agent response text.
 * Returns the clean response and any thinking content separately.
 */
export function extractReasoning(text: string): ExtractedReasoning {
  const thinkingParts: string[] = [];
  let cleaned = text;

  for (const pattern of REASONING_PATTERNS) {
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, (_, inner: string) => {
      const decoded = decodeEntities(inner).trim();
      if (decoded) thinkingParts.push(decoded);
      return '';
    });
  }

  return {
    thinking: thinkingParts.length > 0 ? thinkingParts.join('\n\n') : null,
    response: cleaned.trim(),
  };
}

/** Strip reasoning blocks and return only the clean response text. */
export function stripReasoning(text: string): string {
  return extractReasoning(text).response;
}
