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
import type { TimelineEvent } from './types.js';

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
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
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

/**
 * Return the effective thinking and response for any event.
 * For agent_response events with data.thinking already set (new events from filter),
 * returns them directly. For old events with embedded reasoning HTML in data.prompt,
 * extracts it client-side. For all other event types, returns the prompt as-is.
 */
export function getEffectiveAgentContent(event: TimelineEvent): { thinking: string | null; response: string } {
  const rawPrompt = (event.data.prompt as string | undefined) ?? '';
  if (event.type !== 'agent_response') return { thinking: null, response: rawPrompt };
  if (event.data.thinking) return { thinking: event.data.thinking, response: rawPrompt };
  return extractReasoning(rawPrompt);
}
