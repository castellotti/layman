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

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

// A single combined pass, not chained per-entity replaces: chaining lets an
// earlier replace's output (e.g. "&amp;lt;" -> "&lt;") get matched by a later
// pattern in the same call, over-decoding double-escaped text one step too far.
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCharCode(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, entity) ? NAMED_ENTITIES[entity] : match;
  });
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
