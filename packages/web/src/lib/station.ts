/**
 * Stations: the kind of work a tool call is, read from its recorded name and input.
 *
 * Derived at read time, never stored, so it covers all history, needs no migration and improves
 * without a backfill. Tool names arrive already normalised per harness (`bash` → `Bash`,
 * `read_file` → `Read`, `execute_command` → `Bash`), but their argument keys do not, and several
 * harnesses keep tool names of their own (pi's `web_search`, Vibe's `playwright_browser_*`,
 * Cline's `McpTool`), so every table below lists what Layman actually records.
 *
 * Two copies, byte-identical: `packages/server/src/events/station.ts` and
 * `packages/web/src/lib/station.ts`. Both test suites read one fixture
 * (`packages/server/src/events/station-fixture.json`) and the web suite fails if the files differ.
 * Keep this file free of imports so that stays possible.
 */

export type StationId =
  | 'you'
  | 'model'
  | 'memory'
  | 'files'
  | 'shell'
  | 'network'
  | 'browser'
  | 'agents'
  | 'skills'
  | 'guard';

/** Every station, in the order a legend lists them. */
export const STATION_IDS: readonly StationId[] = [
  'you',
  'model',
  'memory',
  'files',
  'shell',
  'network',
  'browser',
  'agents',
  'skills',
  'guard',
];

// ---- shell lines --------------------------------------------------------------------------------

/**
 * The commands in a shell line, each as its words with quotes removed.
 *
 * A real scanner rather than a split on operators, because what Layman records is full of the cases
 * a split gets wrong: `|` inside a quoted grep pattern, a heredoc body of Python (`import`, `print`)
 * read as commands, a `$(cat <<'EOF' … EOF)` commit message whose apostrophes unbalance the quotes,
 * `\` line continuations. Commands inside `$(…)`, backticks and `( … )` are commands too and are
 * listed alongside the rest: a `curl` inside `$(…)` still reaches the network.
 *
 * Heredoc bodies are data and are skipped. Redirection targets are not commands and are dropped.
 * `powershell` reads a backtick as PowerShell's escape character rather than a substitution.
 */
export function shellCommands(line: string, powershell = false): string[][] {
  const out: string[][] = [];
  scan(line, 0, out, '', powershell);
  return out.map(commandWords).filter((words) => words.length > 0).flatMap((words) => unwrapShell(words, powershell));
}

/**
 * Scans from `start` until `end` (`)` closing a `$(`, a backtick, or '' for the whole line), pushing
 * each command's raw words to `out`. Returns the index just past the terminator.
 */
function scan(src: string, start: number, out: string[][], end: string, powershell: boolean): number {
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let dropNext = false;
  let parens = 0;
  const heredocs: string[] = [];
  const escape = powershell ? '`' : '\\';

  const endWord = (): void => {
    if (!inWord) return;
    if (dropNext) dropNext = false;
    else words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    // A redirection with no target (`cmd >` at a line's end) must not swallow the next command.
    dropNext = false;
    if (words.length > 0) out.push(words);
    words = [];
  };
  /** `$(…)`, `$((…))` or a backtick at `i`: scans what is inside, returns where it ends. */
  const substitution = (i: number): number => {
    if (src.startsWith('$((', i)) {
      // Arithmetic, not commands, except a substitution inside it: skip to the matching `))`.
      let depth = 0;
      for (let j = i + 1; j < src.length; j++) {
        if ((src[j] === '$' && src[j + 1] === '(' && src[j + 2] !== '(') || (!powershell && src[j] === '`')) {
          j = substitution(j) - 1;
          continue;
        }
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) return j + 1;
      }
      return src.length;
    }
    if (src[i] === '`') return scan(src, i + 1, out, '`', powershell);
    return scan(src, i + 2, out, ')', powershell);
  };

  let i = start;
  while (i < src.length) {
    const c = src[i];

    if (c === escape) {
      if (src[i + 1] === '\n') i += 2;
      else {
        word += src[i + 1] ?? '';
        inWord = true;
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const stop = close < 0 ? src.length : close;
      word += src.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        // In bash a backslash escapes only these inside double quotes: `"C:\Program Files"` keeps its own.
        if (src[i] === escape && i + 1 < src.length && (powershell || '$`"\\\n'.includes(src[i + 1]))) {
          word += src[i + 1];
          i += 2;
        } else if ((src[i] === '$' && src[i + 1] === '(') || (!powershell && src[i] === '`')) {
          const stop = substitution(i);
          word += src.slice(i, stop);
          i = stop;
        } else {
          word += src[i];
          i++;
        }
      }
      i++;
      continue;
    }
    if ((c === '$' && src[i + 1] === '(') || (!powershell && c === '`' && end !== '`')) {
      const stop = substitution(i);
      word += src.slice(i, stop);
      inWord = true;
      i = stop;
      continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      const close = src.indexOf('}', i);
      const stop = close < 0 ? src.length : close + 1;
      word += src.slice(i, stop);
      inWord = true;
      i = stop;
      continue;
    }
    if (c === end && end === '`') {
      endCommand();
      return i + 1;
    }
    if (c === ')' && parens === 0 && end === ')') {
      endCommand();
      return i + 1;
    }
    if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      endCommand();
      i++;
      // A heredoc's body starts on the next line and runs to its delimiter alone on a line.
      for (const delimiter of heredocs.splice(0)) {
        while (i < src.length) {
          const eol = src.indexOf('\n', i);
          const stop = eol < 0 ? src.length : eol;
          const bodyLine = src.slice(i, stop).trim();
          i = stop + 1;
          if (bodyLine === delimiter) break;
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    // Inside `[[ … ]]`, `&&`, `||`, `<`, `>` and parentheses are the test's own operators.
    if (/[&|<>()]/.test(c) && insideTest(words)) {
      endWord();
      let op = c;
      while (/[&|]/.test(src[i + op.length] ?? '') && op.length < 2) op += src[i + op.length];
      words.push(op);
      i += op.length;
      continue;
    }
    // `name=(a b c)`: an array, one word.
    if (c === '(' && inWord && word.endsWith('=')) {
      let depth = 0;
      let j = i;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) break;
      }
      word += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // `<(…)` and `>(…)`: process substitution, commands like `$(…)`.
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      endWord();
      const stop = scan(src, i + 2, out, ')', powershell);
      word = src.slice(i, stop);
      inWord = true;
      i = stop;
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      endWord();
      i += 2;
      if (src[i] === '-') i++;
      while (src[i] === ' ' || src[i] === '\t') i++;
      const m = /^(['"]?)([^\s'"<>;&|()]+)\1/.exec(src.slice(i));
      if (m) {
        heredocs.push(m[2]);
        i += m[0].length;
      }
      continue;
    }
    if (c === '>' || c === '<' || (c === '&' && src[i + 1] === '>')) {
      // `2>` carries its descriptor in the word before it.
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      while (i < src.length && /[<>&|]/.test(src[i])) i++;
      // `>&2`, `2>&1`: the descriptor follows directly.
      if (src[i - 1] === '&' && /\d/.test(src[i] ?? '')) {
        while (/\d|-/.test(src[i] ?? '')) i++;
      } else dropNext = true;
      continue;
    }
    if (c === ';' || c === '&' || c === '|') {
      endCommand();
      while (src[i] === ';' || src[i] === '&' || src[i] === '|') i++;
      continue;
    }
    if (c === '(') {
      endCommand();
      parens++;
      i++;
      continue;
    }
    if (c === ')') {
      endCommand();
      if (parens > 0) parens--;
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endCommand();
  return src.length;
}

/** Whether the words so far open a `[[ … ]]` test that has not closed yet. */
function insideTest(words: string[]): boolean {
  const at = words.findIndex((w) => !KEYWORDS.has(w));
  return at >= 0 && words[at] === '[[' && !words.includes(']]', at);
}

/**
 * A table's own entry for a recorded name, never one inherited from `Object.prototype`: a command or
 * tool called `constructor` or `toString` must read as unknown, not as a function.
 */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Words that open or close a construct; the command, if any, follows them. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'function']);
/** A construct whose words are not a command at all. */
const NOT_COMMANDS = new Set(['for', 'case', 'select', 'done', 'fi', 'esac', ';;', 'return', 'break', 'continue']);

const TIMEOUT_FLAGS: ReadonlySet<string> = new Set(['-s', '-k', '--signal', '--kill-after']);

/** Commands that run the command after them; the flags listed take a value. */
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t']),
  env: new Set(['-u', '-C', '-S']),
  nohup: new Set(),
  time: new Set(['-f', '-o']),
  exec: new Set(['-a']),
  command: new Set(),
  builtin: new Set(),
  nice: new Set(['-n']),
  timeout: TIMEOUT_FLAGS,
  gtimeout: TIMEOUT_FLAGS,
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a']),
  watch: new Set(['-n', '-d']),
  stdbuf: new Set(['-i', '-o', '-e']),
  caffeinate: new Set(['-t', '-w']),
  unbuffer: new Set(),
  doas: new Set(['-u']),
};

/** A command's words without leading assignments, keywords and wrappers. Empty when it is no command. */
function commandWords(raw: string[]): string[] {
  let words = raw;
  for (;;) {
    let i = 0;
    while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || KEYWORDS.has(words[i]))) i++;
    words = words.slice(i);
    const head = words[0];
    if (head === undefined || NOT_COMMANDS.has(head)) return [];
    const name = nameOf(head);
    const flags = own(WRAPPERS, name);
    if (flags === undefined) return words;
    // `command -v x` asks where x is; it runs nothing.
    if (name === 'command' && words[1] === '-v') return words;
    if (words.length === 1) return words;
    let j = 1;
    while (j < words.length) {
      const w = words[j];
      if (/^[A-Za-z_]\w*=/.test(w)) j++;
      else if (flags.has(w)) j += 2;
      else if (w.startsWith('-')) j++;
      // timeout's duration
      else if (flags === TIMEOUT_FLAGS && /^\d+(\.\d+)?[smhd]?$/.test(w)) j++;
      else break;
    }
    if (j >= words.length) return words.slice(0, 1);
    words = words.slice(j);
  }
}

/** Shells whose `-c` argument is itself a shell line. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

/** Shell options that take a value (`bash -o pipefail -c …`). */
const SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);

/**
 * The script of `bash -c '<script>'` (or `-lc`, `-ec`, after any options), or undefined when the
 * words are not a shell given a script. One rule for scanned lines and for Codex's argv form.
 */
function shellScript(words: string[]): string | undefined {
  if (!SHELLS.has(nameOf(words[0]))) return undefined;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (/^-[a-z]*c[a-z]*$/.test(w)) return words[i + 1];
    if (SHELL_VALUE_OPTIONS.has(w)) i++;
    else if (!w.startsWith('-') && !w.startsWith('+')) return undefined;
  }
  return undefined;
}

/** `bash -c "curl …"` is the commands inside it. */
function unwrapShell(words: string[], powershell: boolean): string[][] {
  const script = shellScript(words);
  if (script === undefined) return [words];
  const inner = shellCommands(script, powershell);
  return inner.length > 0 ? inner : [words];
}

/**
 * A command's own name: no folder before it, and a Windows program without `.exe`, `.cmd` or `.bat`
 * and in lower case, since Windows does not tell `CURL.EXE` from `curl`.
 */
function nameOf(word = ''): string {
  const name = word.replace(/\\/g, '/').split('/').pop() ?? word;
  const program = name.replace(/\.(exe|cmd|bat)$/i, '');
  return program === name ? name : program.toLowerCase();
}

// ---- what a command is --------------------------------------------------------------------------

/**
 * Commands that only read, search, list, move or edit files. Built from the command heads Layman's
 * own history holds, each decided on purpose; `git` is not here, as its own kind of tool, nor is
 * `sqlite3`, which runs queries.
 */
const FILE_WORDS = new Set([
  'cat', 'head', 'tail', 'sed', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'ls', 'll', 'wc',
  'cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'chgrp', 'diff', 'cmp', 'comm',
  'patch', 'sort', 'uniq', 'cut', 'tr', 'awk', 'gawk', 'tee', 'stat', 'file', 'du', 'df', 'tree',
  'basename', 'dirname', 'realpath', 'readlink', 'jq', 'yq', 'less', 'more', 'nl', 'paste', 'column', 'fold',
  'split', 'col', 'xxd', 'hexdump', 'od', 'strings', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum',
  'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'zcat', 'bzip2', 'xz', 'unxz', 'zstd', '7z', 'iconv', 'mktemp',
  'truncate', 'install', 'ditto', 'xattr', 'mdls', 'mdfind', 'pdftotext', 'pdfinfo', 'base64', 'rev', 'tac',
  'look', 'join', 'expand', 'unexpand', 'fmt', 'pr', 'cpio', 'dd', 'shred', 'sync',
]);

/** Commands that say nothing about the kind of work either way; a line of only these is Shell. */
const NEUTRAL_WORDS = new Set([
  'echo', 'printf', 'cd', 'pushd', 'popd', 'export', 'unset', 'set', 'true', 'false', ':', 'pwd', 'sleep',
  'which', 'type', 'test', '[', '[[', ']]', 'read', 'exit', 'shift', 'local', 'declare', 'typeset',
  'readonly', 'date', 'seq', 'wait', 'trap', 'alias', 'unalias', 'let', 'clear', 'whoami', 'id', 'hostname',
  'uname', 'printenv', 'env', 'tput', 'yes', 'nproc', 'command', 'hash', 'umask', 'ulimit', 'getconf', 'sw_vers',
  'arch', 'tty', 'stty', 'logname', 'groups', 'cal', 'bc', 'expr', 'dc', 'jobs', 'disown', 'bg', 'fg',
  'whatis', 'whereis', 'man', 'help', 'history',
]);

/** Commands that always reach the network. */
const NETWORK_WORDS = new Set([
  'curl', 'wget', 'gh', 'ssh', 'sftp', 'ftp', 'nc', 'ncat', 'netcat', 'telnet', 'ping', 'ping6', 'dig',
  'nslookup', 'host', 'whois', 'traceroute', 'tracepath', 'mtr', 'nmap', 'websocat', 'http', 'https',
  'xh', 'aria2c', 'yt-dlp', 'youtube-dl', 'aws', 'gcloud', 'gsutil', 'az', 'doctl', 'flyctl', 'vercel',
  'netlify', 'wrangler', 'heroku', 'kubectl', 'helm', 'mosh', 'tailscale', 'wg', 'openvpn', 'ssh-keyscan',
  'ssh-copy-id', 'git-lfs', 'hf', 'huggingface-cli', 'dns-sd',
]);

/** Commands that copy to or from another host only when an argument names one (`host:path`). */
const REMOTE_COPY = new Set(['rsync', 'scp', 'rclone']);

/**
 * Commands that reach the network with some of their subcommands. A value of `a b` is a subcommand
 * and the one after it (`uv pip install`, `docker compose pull`).
 */
const PIP_NETWORK: ReadonlySet<string> = new Set(['install', 'download', 'search', 'index']);

const NETWORK_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote', 'remote update', 'submodule update', 'lfs']),
  npm: new Set(['install', 'i', 'ci', 'add', 'update', 'up', 'publish', 'view', 'info', 'show', 'audit',
    'outdated', 'search', 'login', 'pack', 'exec', 'dist-tag', 'deprecate', 'unpublish']),
  pnpm: new Set(['install', 'i', 'add', 'update', 'up', 'publish', 'dlx', 'outdated', 'audit', 'view', 'info']),
  yarn: new Set(['install', 'add', 'upgrade', 'up', 'publish', 'dlx', 'info', 'npm']),
  bun: new Set(['install', 'i', 'add', 'update', 'publish', 'x']),
  bunx: new Set(['*']),
  pip: PIP_NETWORK,
  pip3: PIP_NETWORK,
  pipx: new Set(['install', 'upgrade', 'run']),
  uv: new Set(['add', 'sync', 'lock', 'pip install', 'pip compile', 'pip sync', 'tool install', 'tool upgrade',
    'python install', 'publish', 'self update']),
  poetry: new Set(['install', 'add', 'update', 'lock', 'publish']),
  docker: new Set(['pull', 'push', 'login', 'search', 'compose pull', 'compose push', 'buildx']),
  podman: new Set(['pull', 'push', 'login', 'search', 'compose pull', 'compose push']),
  brew: new Set(['install', 'reinstall', 'update', 'upgrade', 'fetch', 'search', 'info', 'tap', 'outdated']),
  'apt-get': new Set(['install', 'update', 'upgrade', 'dist-upgrade', 'download', 'source']),
  apt: new Set(['install', 'update', 'upgrade', 'full-upgrade', 'download', 'search', 'show']),
  dnf: new Set(['install', 'update', 'upgrade', 'download', 'search', 'makecache']),
  yum: new Set(['install', 'update', 'upgrade', 'search']),
  pacman: new Set(['-S', '-Sy', '-Syu', '-Ss']),
  apk: new Set(['add', 'update', 'upgrade', 'fetch']),
  cargo: new Set(['install', 'fetch', 'publish', 'update', 'search', 'add']),
  go: new Set(['get', 'install', 'mod download', 'mod tidy']),
  gem: new Set(['install', 'update', 'push', 'fetch']),
  bundle: new Set(['install', 'update']),
  composer: new Set(['install', 'update', 'require']),
  mvn: new Set(['install', 'deploy', 'dependency:resolve']),
  ollama: new Set(['pull', 'push']),
  snap: new Set(['install', 'refresh']),
  flatpak: new Set(['install', 'update']),
  mas: new Set(['install', 'upgrade']),
  softwareupdate: new Set(['-i', '-l', '--install', '--list']),
  npx: new Set(['-y', '--yes']),
  corepack: new Set(['enable', 'prepare', 'install']),
  rustup: new Set(['update', 'install', 'toolchain install', 'target add', 'component add']),
  nix: new Set(['build', 'develop', 'shell', 'run', 'flake update']),
  openssl: new Set(['s_client']),
  pyenv: new Set(['install', 'update']),
  fnm: new Set(['install']),
  nvm: new Set(['install']),
  esphome: new Set(['upload', 'run', 'logs']),
};

/** Flags before a subcommand that take a value, per command (`git -C dir push`). */
const SUBCOMMAND_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']),
  npm: new Set(['--prefix', '-w', '--workspace', '-C']),
  pnpm: new Set(['--filter', '-F', '-C', '--dir', '-w', '--workspace']),
  yarn: new Set(['--cwd']),
  uv: new Set(['--directory', '--project', '--python', '-p']),
  docker: new Set(['--context', '-c', '-H', '--host', '--config', '-f', '--file', '-p', '--project-name']),
  podman: new Set(['--connection', '-c', '--url', '-f', '--file', '-p']),
  cargo: new Set(['-C', '--manifest-path', '--config']),
  go: new Set(['-C']),
};

/**
 * A command's subcommand and the word after it, flags skipped before and between them
 * (`git -C dir push`, `docker compose -f a.yml pull`). A flag-shaped subcommand (`pacman -S`,
 * `npx -y`) counts when it comes first.
 */
function subcommandOf(words: string[], head: string, subs: ReadonlySet<string>): [string, string] {
  const valueFlags = own(SUBCOMMAND_VALUE_FLAGS, head);
  const found: string[] = [];
  for (let i = 1; i < words.length && found.length < 2; i++) {
    const w = words[i];
    if (found.length === 0 && subs.has(w)) found.push(w);
    else if (w.startsWith('-')) {
      if (valueFlags?.has(w)) i++;
    } else found.push(w);
  }
  return [found[0] ?? '', found[1] ?? ''];
}

/** `host:path` or `user@host:path`: not a local path, not a URL, not a Windows drive. */
const REMOTE_ARG = /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/)/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
/** A copy tool's own URL form (`rsync://host/module`). */
const COPY_URL = /^(?:rsync|scp|sftp):\/\//;

function reachesNetwork(words: string[], head: string): boolean {
  if (NETWORK_WORDS.has(head)) return true;
  if (REMOTE_COPY.has(head)) {
    return words
      .slice(1)
      .some((w) => !w.startsWith('-') && (COPY_URL.test(w) || (REMOTE_ARG.test(w) && !WINDOWS_DRIVE.test(w))));
  }
  const subs = own(NETWORK_SUBCOMMANDS, head);
  if (subs === undefined) return false;
  if (subs.has('*')) return true;
  const [sub, next] = subcommandOf(words, head, subs);
  return subs.has(sub) || subs.has(`${sub} ${next}`);
}

// PowerShell's own names, in lower case: PowerShell does not tell cases apart.
const PS_FILE_WORDS = new Set([
  'get-content', 'gc', 'set-content', 'add-content', 'out-file', 'get-childitem', 'gci', 'dir', 'get-item',
  'gi', 'select-string', 'sls', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move', 'rename-item', 'ren',
  'remove-item', 'ri', 'del', 'new-item', 'ni', 'md', 'test-path', 'resolve-path', 'get-filehash',
  'compress-archive', 'expand-archive',
]);
const PS_NEUTRAL_WORDS = new Set([
  'write-host', 'write-output', 'set-location', 'sl', 'get-location', 'gl', 'start-sleep', 'select-object',
  'select', 'where-object', 'where', '?', 'foreach-object', 'foreach', '%', 'sort-object', 'measure-object',
  'measure', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'out-null', 'get-date',
]);
const PS_NETWORK_WORDS = new Set([
  'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'test-connection', 'test-netconnection',
  'resolve-dnsname', 'start-bitstransfer',
]);

/** What one command is: `network`, `files`, `neutral`, or `shell` for anything else. */
export type CommandKind = 'network' | 'files' | 'neutral' | 'shell';

export function commandKind(words: string[], powershell = false): CommandKind {
  // PowerShell keeps results in `$name = …` and runs a quoted path with `&`: neither is the command.
  let w = words;
  if (powershell) {
    if (/^\$[\w:]+$/.test(w[0] ?? '') && w[1] === '=') w = w.slice(2);
    if (w[0] === '&' || w[0] === '.') w = w.slice(1);
  }
  const head = powershell ? nameOf(w[0]).toLowerCase() : nameOf(w[0]);
  if (reachesNetwork(w, head) || (powershell && PS_NETWORK_WORDS.has(head))) return 'network';
  // A copy that names no other host is a local one.
  if (FILE_WORDS.has(head) || REMOTE_COPY.has(head) || (powershell && PS_FILE_WORDS.has(head))) return 'files';
  if (NEUTRAL_WORDS.has(head) || (powershell && PS_NEUTRAL_WORDS.has(head))) return 'neutral';
  return 'shell';
}

/**
 * A shell line's station. Network if any command in it reaches the network; Files if every command
 * that is not neutral works on files; Shell otherwise, including a line of only neutral commands.
 */
export function shellStation(line: string, powershell = false): 'network' | 'files' | 'shell' {
  const kinds = shellCommands(line, powershell).map((words) => commandKind(words, powershell));
  if (kinds.includes('network')) return 'network';
  const real = kinds.filter((k) => k !== 'neutral');
  return real.length > 0 && real.every((k) => k === 'files') ? 'files' : 'shell';
}

// ---- tool calls ---------------------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * A shell tool's command line: a string, or an argv array as older Codex records it. An argv of
 * `bash -lc <script>` is the script; any other argv is its words, quoted back so spaces survive.
 */
function commandLine(input: Record<string, unknown>): string {
  const c = input.command ?? input.cmd;
  if (!Array.isArray(c)) return str(c);
  const argv = c.map(String);
  const script = shellScript(argv);
  if (script !== undefined) return script;
  return argv.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** Tools whose input is a shell line, as each harness names them once normalised. */
const SHELL_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'exec_command']);

/** Tools by name, across every harness Layman records. A name not here falls to the rules below. */
const TOOL_STATIONS: Record<string, StationId> = {
  // Files: claude-code, and every harness's name once Layman has normalised it.
  Read: 'files', Write: 'files', Edit: 'files', MultiEdit: 'files', NotebookEdit: 'files', NotebookRead: 'files',
  Grep: 'files', Glob: 'files', LS: 'files', ListDirectory: 'files', LSP: 'files',
  search_replace: 'files', // Mistral Vibe
  apply_patch: 'files', // Codex
  list: 'files', patch: 'files', multiedit: 'files', // OpenCode, unmapped
  view_image: 'files', // Codex
  // Network
  WebFetch: 'network', WebSearch: 'network', Artifact: 'network',
  web_search: 'network', web_fetch: 'network', web_download: 'network', web_download_status: 'network', // pi
  searxng_web_search: 'network', webfetch_fetch_url: 'network', // Mistral Vibe
  McpResource: 'network', // Cline
  webfetch: 'network', websearch: 'network', // OpenCode, unmapped
  // Browser
  Browser: 'browser', // Cline's browser_action
  // You: the person is asked, or shown something
  AskUserQuestion: 'you', AskUser: 'you', ask_user_question: 'you', SendUserFile: 'you',
  EnterPlanMode: 'you', ExitPlanMode: 'you', PlanRespond: 'you', ActRespond: 'you', ReportFindings: 'you',
  Complete: 'you', // Cline's attempt_completion
  question: 'you', // OpenCode
  // Model: the agent's own bookkeeping, with nothing outside it touched
  TaskCreate: 'model', TaskUpdate: 'model', TaskList: 'model', TaskGet: 'model', TodoWrite: 'model',
  TodoRead: 'model', todo: 'model', todowrite: 'model', todoread: 'model', update_plan: 'model',
  FocusChain: 'model', Summarize: 'model', Compact: 'model', Explain: 'model',
  // Agents: other agents, and work started to run on later
  Agent: 'agents', Task: 'agents', task: 'agents', NewTask: 'agents', SubagentHandback: 'agents',
  SendMessage: 'agents', ListAgents: 'agents', TaskStop: 'agents', TaskOutput: 'agents', Workflow: 'agents',
  ScheduleWakeup: 'agents', CronCreate: 'agents', CronDelete: 'agents', CronList: 'agents',
  RemoteTrigger: 'agents', Subagents: 'agents', // Cline's use_subagents
  // Skills
  Skill: 'skills', skill: 'skills', ToolSearch: 'skills', NewRule: 'skills',
  McpDocs: 'skills', // Cline's load_mcp_documentation: learning what tools there are, like ToolSearch
  // Shell: runs commands, or watches them
  Monitor: 'shell', EnterWorktree: 'shell', ExitWorktree: 'shell', ReportBug: 'shell',
};

/** MCP servers by what they are; any other server is Network, as a remote tool is until shown otherwise. */
const BROWSER_SERVERS = /(?:^|[_-])(?:playwright|puppeteer|browser|chrome|chromium|Claude_Browser|claude-in-chrome)(?:$|[_-])/i;
const SHELL_SERVERS = new Set(['terminal', 'shell', 'desktop-commander']);
const FILE_SERVERS = new Set(['filesystem', 'fs']);

/** `mcp__server__tool`, as claude-code and pi name an MCP tool. */
function mcpParts(tool: string): [string, string] | undefined {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(tool);
  return m ? [m[1], m[2]] : undefined;
}

function mcpStation(server: string): StationId {
  if (BROWSER_SERVERS.test(server)) return 'browser';
  if (SHELL_SERVERS.has(server)) return 'shell';
  if (FILE_SERVERS.has(server)) return 'files';
  if (server === 'visualize' || server.startsWith('ccd_')) return 'you';
  if (server === 'plugin-authoring') return 'skills';
  return 'network';
}

// ---- memory ------------------------------------------------------------------------------------

/** What the person has named as memory, beyond Claude Code's own memory folder. */
export interface StationSetup {
  /** Path parts: a call on a path containing one of these is Memory (`/notes/`, `.remember/`). */
  memoryPaths: readonly string[];
  /** MCP server names whose tools are Memory (`mcp__<server>__…`, Vibe's `<server>_…`, Cline's server_name). */
  memoryServers: readonly string[];
}

export const NO_SETUP: StationSetup = { memoryPaths: [], memoryServers: [] };

/** Paths with Windows separators written as `/`, so one rule reads every system's paths. */
const slashes = (path: string): string => path.replace(/\\/g, '/');

/** Claude Code's auto-memory folder, for everyone: `~/.claude/projects/<project>/memory/`. */
const CLAUDE_MEMORY = /(?:^|\/)\.claude\/projects\/[^/]+\/memory(?:\/|$|[\s'"])/;

/** Whether a path, or a shell line naming paths, is in memory. */
export function isMemoryPath(text: string, setup: StationSetup = NO_SETUP): boolean {
  const t = slashes(text);
  return CLAUDE_MEMORY.test(t) || setup.memoryPaths.some((part) => part.trim() !== '' && t.includes(slashes(part.trim())));
}

/** Keys a harness may use for the file or folder a call works on. */
const PATH_KEYS = ['file_path', 'path', 'filePath', 'filepath', 'notebook_path'] as const;

function pathOf(input: Record<string, unknown>): string {
  for (const key of PATH_KEYS) if (str(input[key]) !== '') return str(input[key]);
  return '';
}

/** The MCP server a tool belongs to, in any harness's naming, if it is one the person called memory. */
function isMemoryServer(toolName: string, input: Record<string, unknown>, setup: StationSetup): boolean {
  if (setup.memoryServers.length === 0) return false;
  const server = mcpParts(toolName)?.[0] ?? (toolName === 'McpTool' ? str(input.server_name) : undefined);
  if (server !== undefined) return setup.memoryServers.includes(server);
  // Mistral Vibe names an MCP tool `<server>_<tool>`.
  return setup.memoryServers.some((name) => name !== '' && toolName.startsWith(`${name}_`));
}

// ---- tool calls and events ------------------------------------------------------------------------

/**
 * The station of a tool call, from its recorded name and input. Total: an unknown tool is Shell.
 * `toolInput` may be undefined (a call recorded without arguments). A Files call on a memory path,
 * and any tool of a memory server, is Memory.
 */
export function stationOf(toolName: string, toolInput?: Record<string, unknown>, setup: StationSetup = NO_SETUP): StationId {
  const input = toolInput ?? {};
  if (isMemoryServer(toolName, input, setup)) return 'memory';
  const station = toolStation(toolName, input);
  if (station !== 'files') return station;
  const where = SHELL_TOOLS.has(toolName) || toolName === 'PowerShell' ? commandLine(input) : pathOf(input);
  return where !== '' && isMemoryPath(where, setup) ? 'memory' : 'files';
}

function toolStation(toolName: string, input: Record<string, unknown>): StationId {
  if (SHELL_TOOLS.has(toolName)) return shellStation(commandLine(input));
  if (toolName === 'PowerShell') return shellStation(commandLine(input), true);
  const known = own(TOOL_STATIONS, toolName);
  if (known !== undefined) return known;
  // pi's own browser tools, and Mistral Vibe's MCP tools named `<server>_<tool>`.
  if (/^(?:playwright_)?browser_/.test(toolName)) return 'browser';
  const mcp = mcpParts(toolName);
  if (mcp) return mcpStation(mcp[0]);
  // Cline's use_mcp_tool names its server in the input.
  if (toolName === 'McpTool') return mcpStation(str(input.server_name));
  return 'shell';
}

/** Events that are one tool call at some point of its life: they take the call's own station. */
const TOOL_EVENTS = new Set(['tool_call_pending', 'tool_call_completed', 'tool_call_failed']);

/**
 * Events by station. Guard is Layman's own decisions about a call (an approval, a denial, a hand-off
 * to the terminal, a drift check or alert), never the call itself, which keeps its own station.
 */
const EVENT_STATIONS: Record<string, StationId> = {
  user_prompt: 'you', elicitation: 'you', elicitation_result: 'you',
  agent_response: 'model', pre_compact: 'model', post_compact: 'model', stop_failure: 'model',
  instructions_loaded: 'memory',
  file_changed: 'files',
  web_search: 'network',
  subagent_start: 'agents', subagent_stop: 'agents', task_created: 'agents', task_completed: 'agents',
  teammate_idle: 'agents',
  tool_call_approved: 'guard', tool_call_denied: 'guard', tool_call_delegated: 'guard',
  permission_request: 'guard', permission_denied: 'guard', drift_check: 'guard', drift_alert: 'guard',
};

/**
 * The station of a recorded event, or undefined for one that is no work at all (a session starting,
 * a notification, metrics). `data` is the event's recorded data (`toolName`, `toolInput`).
 */
export function eventStation(type: string, data: Record<string, unknown> | undefined, setup: StationSetup = NO_SETUP): StationId | undefined {
  if (TOOL_EVENTS.has(type)) {
    const input = data?.toolInput;
    return stationOf(str(data?.toolName), typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : undefined, setup);
  }
  return own(EVENT_STATIONS, type);
}

/**
 * Memory the model did not ask for: a harness loading instructions (CLAUDE.md, AGENTS.md, rules) into
 * its context. Counted apart from memory the model read or searched itself.
 */
export function isPushedMemory(type: string): boolean {
  return type === 'instructions_loaded';
}
