/**
 * Turns an agent response into something worth hearing out loud.
 *
 * **Deliberately does not strip emoji or markdown emphasis.** speaches already
 * runs `strip_emojis()` and `strip_markdown_emphasis()` over its input, so doing
 * it here would be a second implementation of someone else's rule — one that
 * would silently rot the first time they changed theirs. What is left for us is
 * the structural noise speaches does *not* touch: fenced code, link URLs,
 * headings, tables and HTML.
 *
 * The guiding question for every rule below is "does a listener lose anything
 * if this disappears?" Forty lines of OpenSCAD read aloud is not information,
 * it is an obstacle. An identifier inside backticks usually *is* the point.
 */
import { getEffectiveAgentContent } from './reasoning.js';
import type { TimelineEvent } from './types.js';

export interface SpeechTextOpts {
  /** Fenced code: drop it silently, or say "code block" in its place. */
  codeBlocks?: 'skip' | 'announce';
  /** Hard cap; the cut is moved back to a sentence boundary where possible. */
  maxChars?: number;
}

const DEFAULTS: Required<SpeechTextOpts> = { codeBlocks: 'announce', maxChars: 4000 };

/**
 * Truncate at `max`, preferring the last sentence end. Cutting mid-sentence is
 * jarring when spoken, but so is discarding most of a paragraph to find a
 * period — hence the 60% floor, below which we fall back to a word boundary.
 */
export function truncateForSpeech(text: string, max: number): string {
  if (text.length <= max) return text;

  const head = text.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentenceEnd > max * 0.6) return head.slice(0, sentenceEnd + 1);

  const wordEnd = head.lastIndexOf(' ');
  return `${(wordEnd > 0 ? head.slice(0, wordEnd) : head).trimEnd()}…`;
}

/** Markdown (and light HTML) → prose. */
export function toSpeakableText(raw: string, opts: SpeechTextOpts = {}): string {
  const { codeBlocks, maxChars } = { ...DEFAULTS, ...opts };
  let text = raw ?? '';

  // Fenced code first, so nothing inside it is interpreted as markdown.
  text = text.replace(/```[\s\S]*?```/g, codeBlocks === 'skip' ? '' : ' Code block. ');
  text = text.replace(/~~~[\s\S]*?~~~/g, codeBlocks === 'skip' ? '' : ' Code block. ');

  // HTML — <details type="reasoning"> is already gone via getEffectiveAgentContent,
  // but responses still carry the odd <br> or <b>.
  text = text.replace(/<[^>]+>/g, ' ');

  // Images carry nothing audible; links keep their text, which is the readable part.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // A bare URL read character by character is unlistenable.
  text = text.replace(/\bhttps?:\/\/\S+/g, 'link');

  // Inline code: drop the backticks, keep the identifier.
  text = text.replace(/`([^`]*)`/g, '$1');

  text = text
    .split('\n')
    .map((line) => {
      // Table separators (|---|:--:|) are pure layout.
      if (/^\s*\|?[\s:|-]*\|[\s:|-]*$/.test(line) && line.includes('|')) return '';
      // Horizontal rules likewise.
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) return '';

      let out = line;
      out = out.replace(/^\s*#{1,6}\s+/, '');       // heading markers
      out = out.replace(/^\s*>+\s?/, '');           // blockquote markers
      out = out.replace(/^\s*[-*+]\s+/, '');        // bullets — numbers stay, Kokoro reads them fine
      // Table cells become a comma-separated run rather than a wall of pipes.
      if (out.includes('|')) out = out.replace(/\s*\|\s*/g, ', ').replace(/^,\s*|,\s*$/g, '');
      return out;
    })
    .join('\n');

  // Paragraph breaks become sentence breaks so speech does not run two
  // paragraphs together; everything else collapses to single spaces.
  text = text.replace(/\n{2,}/g, '. ').replace(/\s+/g, ' ').trim();

  // The rules above can leave doubled or orphaned punctuation behind.
  text = text.replace(/\s+([.,!?;:])/g, '$1').replace(/([.!?])[.\s]*\1+/g, '$1').replace(/^[.,\s]+/, '');

  return truncateForSpeech(text.trim(), maxChars);
}

/**
 * What to speak for one event.
 *
 * Defaults to the agent's actual words. `speakLaymans` is opt-in because it only
 * exists when autoExplain is on — falling back to the raw response keeps the
 * button from doing nothing on a turn that was never explained.
 */
export function speechTextForEvent(
  event: TimelineEvent,
  opts: SpeechTextOpts & { speakLaymans?: boolean } = {},
): string {
  if (opts.speakLaymans && event.laymans?.explanation) {
    return toSpeakableText(event.laymans.explanation, opts);
  }
  return toSpeakableText(getEffectiveAgentContent(event).response, opts);
}
