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
