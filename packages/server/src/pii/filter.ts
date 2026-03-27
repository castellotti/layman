import type { EventData } from '../events/types.js';

const REDACTED = '[REDACTED]';

/** Named pattern entry for introspection */
interface PiiPattern {
  id: string;
  regex: RegExp;
}

/**
 * Regex patterns for detecting PII in text.
 * Order matters — more specific patterns should come before generic ones
 * to avoid partial matches.
 */
export const PII_PATTERNS: PiiPattern[] = [
  // Private keys (PEM-encoded)
  {
    id: 'secret',
    regex: /-----BEGIN\s[\w\s]+?PRIVATE\sKEY-----[\s\S]*?-----END\s[\w\s]+?PRIVATE\sKEY-----/g,
  },
  // JWT tokens
  {
    id: 'secret',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  // Generic API keys / tokens (long hex or base64 strings preceded by key-like labels)
  {
    id: 'secret',
    regex: /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|bearer|secret[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?([A-Za-z0-9_\-/.+]{20,})['"]?/gi,
  },
  // Password assignments in text/config
  {
    id: 'secret',
    regex: /(?:password|passwd|pwd)\s*[:=]\s*['"]?(\S{1,128})['"]?/gi,
  },
  // Email addresses
  {
    id: 'email',
    regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
  },
  // Credit card numbers (13-19 digits, optionally separated by spaces or dashes)
  {
    id: 'credit_card',
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
  },
  // IBAN (2 letters, 2 digits, then 4-30 alphanumeric)
  {
    id: 'iban',
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g,
  },
  // US Social Security Numbers
  {
    id: 'ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  // Passport numbers (common format: 1-2 letters followed by 6-9 digits)
  {
    id: 'passport',
    regex: /\b[A-Z]{1,2}\d{6,9}\b/g,
  },
  // MAC addresses (colon or dash separated)
  {
    id: 'mac',
    regex: /\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b/g,
  },
  {
    id: 'mac',
    regex: /\b[0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5}\b/g,
  },
  // IPv6 addresses (full or compressed)
  {
    id: 'ipv6',
    regex: /\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b/g,
  },
  {
    id: 'ipv6',
    regex: /\b(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}\b/g,
  },
  // IPv4 addresses
  {
    id: 'ipv4',
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  },
  // Phone numbers (international with + prefix, or common formats with area codes)
  {
    id: 'phone',
    regex: /(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g,
  },
  // US driver's license (varies by state; generic pattern: 1 letter + 4-12 digits)
  {
    id: 'drivers_license',
    regex: /\b[A-Z]\d{4,12}\b/g,
  },
];

// Allowlist: common non-PII strings that match patterns above but should not be redacted
const ALLOWLIST: Set<string> = new Set([
  // Localhost / loopback
  '127.0.0.1',
  '0.0.0.0',
  '255.255.255.255',
  '255.255.255.0',
  // Common Docker / container addresses
  '172.17.0.1',
  '172.17.0.2',
  // Common tool names / refs that look like driver's license pattern
  'Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write',
]);

/**
 * Apply PII redaction to a single string.
 * Returns the redacted version.
 */
export function redactString(input: string): string {
  let result = input;
  for (const { regex } of PII_PATTERNS) {
    // Reset lastIndex for global regexes
    regex.lastIndex = 0;
    result = result.replace(regex, (match) => {
      if (ALLOWLIST.has(match)) return match;
      return REDACTED;
    });
  }
  return result;
}

/**
 * Recursively walk a value and redact any strings found.
 */
function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = redactValue(v);
    }
    return result;
  }
  return value;
}

/**
 * Filter PII from EventData.
 * Deep-clones and redacts all string fields.
 */
export function filterPii(data: EventData): EventData {
  return redactValue(data) as EventData;
}
