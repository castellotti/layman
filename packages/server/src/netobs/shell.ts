/**
 * Which of glove's relays a shell command uses, from its leading words only.
 *
 * glove's relays put shims in the harness image: `gh` (every call), `git` (only
 * `push`, `fetch`, `pull`, `clone` and `ls-remote` go out; `pull` is a relayed
 * fetch), and `ssh <name> …` (one forwarder per configured host, gate `ssh-<name>`).
 * A shell command names no URL, so without this its relay traffic is Unattributed.
 *
 * Only a command a segment *starts with* counts: `echo "gh pr list"`, or a `gh`
 * inside quotes, never claims. Quotes are respected when splitting on `&&`, `||`,
 * `;`, `|` and newlines; leading `VAR=value` assignments and a few wrappers
 * (`env`, `time`, `command`, `exec`, `nohup`) are skipped.
 */

export type Relay = { via: 'github' | 'ssh'; host: string | null };

const GIT_REMOTE = new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote']);
/** git options that take the next word as their value. */
const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
/** ssh options that take a value (`ssh -p 2222 build`): OpenSSH's `bcDEeFIiJLlmOoPpQRSWw`. */
const SSH_ARG_OPTS = new Set('bcDEeFIiJLlmOoPpQRSWw'.split(''));
const WRAPPERS = new Set(['env', 'time', 'command', 'exec', 'nohup']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Words of each command segment, quotes removed, split on unquoted separators. */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inWord = true; continue; }
    if (c === '\\' && i + 1 < command.length) { word += command[++i]; inWord = true; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')') { endSegment(); continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    word += c;
    inWord = true;
  }
  endSegment();
  return segments;
}

function relayOfSegment(words: string[]): Relay | null {
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i]) || WRAPPERS.has(words[i]))) i++;
  const cmd = words[i]?.replace(/^.*\//, '');
  const rest = words.slice(i + 1);
  if (cmd === 'gh') return { via: 'github', host: null };
  if (cmd === 'git') {
    for (let j = 0; j < rest.length; j++) {
      const w = rest[j];
      if (GIT_ARG_OPTS.has(w)) { j++; continue; }
      if (w.startsWith('-')) continue;
      return GIT_REMOTE.has(w) ? { via: 'github', host: null } : null;
    }
    return null;
  }
  if (cmd === 'ssh') {
    for (let j = 0; j < rest.length; j++) {
      const w = rest[j];
      if (w === '--') { j++; return rest[j] ? { via: 'ssh', host: rest[j].replace(/^.*@/, '') } : null; }
      if (w.startsWith('-') && w.length > 1) {
        // `-p2222` carries its value; `-p 2222` takes the next word.
        if (w.length === 2 && SSH_ARG_OPTS.has(w[1])) j++;
        continue;
      }
      return { via: 'ssh', host: w.replace(/^.*@/, '') || null };
    }
    return null;
  }
  return null;
}

/** The first relay a command's segments start with, or null. */
export function relayOf(command: string): Relay | null {
  for (const words of shellSegments(command)) {
    const r = relayOfSegment(words);
    if (r) return r;
  }
  return null;
}
