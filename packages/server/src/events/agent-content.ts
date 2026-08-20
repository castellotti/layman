/**
 * Server-side counterpart to packages/web/src/lib/reasoning.ts.
 *
 * Strips reasoning/thinking blocks from agent response text so exports, TTS and
 * markdown serialization all agree on "what the agent actually said".
 *
 * Events recorded after the PII filter's reasoning split have `data.thinking`
 * populated and `data.prompt` already clean; older events carry raw
 * `<details type="reasoning">` / `<think>` HTML in `data.prompt`.  Both are
 * handled here.
 *
 * Keep in sync with packages/web/src/lib/reasoning.ts — see CLAUDE.md
 * "Type duplication".
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
  thinking: string | null;
  response: string;
}

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

export function stripReasoning(text: string): string {
  return extractReasoning(text).response;
}

/**
 * The single meaning of "what the agent said" for a given event.
 * Non-`agent_response` events return their prompt text verbatim.
 */
export function getEffectiveAgentContent(event: TimelineEvent): ExtractedReasoning {
  const rawPrompt = event.data.prompt ?? '';
  if (event.type !== 'agent_response') return { thinking: null, response: rawPrompt };
  if (event.data.thinking) return { thinking: event.data.thinking, response: rawPrompt };
  return extractReasoning(rawPrompt);
}
