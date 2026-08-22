/**
 * Reading tool-call arguments across harnesses.
 *
 * Every harness names its arguments differently, and Layman normalises only the
 * *tool name* on the way in (`Bash`, `Read`, `Glob`, …) — not the argument keys,
 * which are passed through verbatim so nothing is lost. That means anything
 * reading a path out of `toolInput` has to know the aliases:
 *
 *   claude-code / Cline / OpenCode   `file_path`
 *   pi                               `path`
 *
 * Getting this wrong fails quietly and in an easy-to-miss way: the call still
 * appears, just with no path in its summary, raw JSON where the one-line
 * description should be, and — worse — nothing recorded in file-access tracking.
 *
 * Mirrored in `packages/web/src/lib/tool-input.ts`; see CLAUDE.md "Type duplication".
 */

/** Keys a harness may use for "the file this call operates on", in priority order. */
const FILE_PATH_KEYS = ['file_path', 'path', 'filePath', 'filepath'] as const;

/**
 * Tools whose `path` argument is the directory to search, not a file operated on.
 *
 * Without this exclusion every `Grep` and `Glob` in a session summarises as the
 * same repository root — `Grep — /Users/me/project` repeated dozens of times —
 * because `path` outranks `pattern`, which is the argument that actually says
 * what the call was looking for. Pass `toolName` at any call site that renders a
 * summary; access tracking handles these two tools explicitly and does not.
 */
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);

/**
 * The file a tool call touches, whatever the harness calls the argument.
 *
 * `toolName` is optional because most callers have a path-shaped tool in hand
 * already; supply it wherever a search tool could turn up.
 */
export function toolFilePath(
  input: Record<string, unknown> | undefined,
  toolName?: string
): string | undefined {
  if (!input) return undefined;
  if (toolName && SEARCH_TOOLS.has(toolName)) return undefined;
  for (const key of FILE_PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

/**
 * The line window of a partial read, as pi renders it: `:320-419`.
 *
 * Derived from the arguments rather than read from a result field, because that
 * is where the information is — pi's own `formatReadCall` computes
 * `end = offset + limit - 1` the same way, and `ReadToolDetails` carries only
 * truncation state. Returns '' when the call read the whole file, so it can be
 * concatenated unconditionally.
 */
export function toolLineRange(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const offset = typeof input.offset === 'number' ? input.offset : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : undefined;
  if (offset === undefined && limit === undefined) return '';

  const start = offset ?? 1;
  // A limit with no offset still starts at line 1, which is what pi shows.
  const end = limit !== undefined ? start + limit - 1 : undefined;
  return end !== undefined ? `:${start}-${end}` : `:${start}`;
}

/** `…/autocomplete.js:320-419` — the path plus its line window, if any. */
export function toolPathWithRange(
  input: Record<string, unknown> | undefined,
  toolName?: string
): string | undefined {
  const path = toolFilePath(input, toolName);
  if (!path) return undefined;
  return `${path}${toolLineRange(input)}`;
}
