import type { FileAccess, UrlAccess } from './types.js';

export interface AccessExtractionResult {
  files: FileAccess[];
  urls: UrlAccess[];
}

function basename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

function tryParseHostname(urlStr: string): string | null {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return null;
  }
}

function makeFileAccess(
  path: string,
  operation: FileAccess['operation'],
  eventId: string,
  toolName: string,
  timestamp: number
): FileAccess {
  return { path, filename: basename(path), operation, eventId, toolName, timestamp };
}

function makeUrlAccess(
  url: string,
  eventId: string,
  toolName: string,
  timestamp: number,
  bytesIn?: number,
  bytesOut?: number
): UrlAccess | null {
  const hostname = tryParseHostname(url);
  if (!hostname) return null;
  return { url, hostname, eventId, toolName, timestamp, bytesIn, bytesOut };
}

/** Conservative regex to extract file paths from rm commands */
const RM_PATTERN = /\brm\s+(?:-[a-zA-Z]*\s+)*([^\s;|&>]+)/g;

/** Strip heredoc bodies so their content doesn't get parsed as file paths.
 *  Keeps the first line (e.g. `cat > file << 'EOF'`) so redirect detection still works. */
function stripHeredocs(command: string): string {
  return command.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1(?:\s|$)/g, (match, _delim) => {
    return match.split('\n')[0];
  });
}

function estimateBytes(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value).length;
  } catch {
    return undefined;
  }
}

export function extractAccess(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  toolOutput: unknown | undefined,
  eventId: string,
  timestamp: number
): AccessExtractionResult {
  const files: FileAccess[] = [];
  const urls: UrlAccess[] = [];

  if (!toolInput) return { files, urls };

  const filePath = toolInput.file_path as string | undefined;

  switch (toolName) {
    case 'Read': {
      if (filePath) files.push(makeFileAccess(filePath, 'read', eventId, toolName, timestamp));
      break;
    }
    case 'Write': {
      if (filePath) files.push(makeFileAccess(filePath, 'wrote', eventId, toolName, timestamp));
      break;
    }
    case 'Edit':
    case 'MultiEdit': {
      if (filePath) files.push(makeFileAccess(filePath, 'edited', eventId, toolName, timestamp));
      break;
    }
    case 'Bash': {
      const rawCommand = (toolInput.command as string) ?? '';
      const command = stripHeredocs(rawCommand);
      let match: RegExpExecArray | null;

      // rm → deleted
      RM_PATTERN.lastIndex = 0;
      while ((match = RM_PATTERN.exec(command)) !== null) {
        const path = match[1];
        if (path && !path.startsWith('-')) {
          files.push(makeFileAccess(path, 'deleted', eventId, toolName, timestamp));
        }
      }

      // Output redirections: > file (wrote) or >> file (edited/append)
      const REDIRECT_PATTERN = /(>{1,2})\s*([^\s|;&'"<>]+)/g;
      REDIRECT_PATTERN.lastIndex = 0;
      while ((match = REDIRECT_PATTERN.exec(command)) !== null) {
        const path = match[2];
        if (path && !path.startsWith('-') && !path.startsWith('/dev/')) {
          files.push(makeFileAccess(path, match[1] === '>>' ? 'edited' : 'wrote', eventId, toolName, timestamp));
        }
      }

      // cat/head/tail reading files — extract absolute paths from the command
      // Skip when output redirect is present (e.g. cat > file — writing, not reading)
      if (/\b(?:cat|head|tail|wc)\b/.test(command) && !/>/.test(command)) {
        const PATH_PATTERN = /\s(\/(?!dev\/)\S+)/g;
        PATH_PATTERN.lastIndex = 0;
        while ((match = PATH_PATTERN.exec(command)) !== null) {
          files.push(makeFileAccess(match[1], 'read', eventId, toolName, timestamp));
        }
      }

      break;
    }
    case 'Glob':
    case 'Grep': {
      const searchPath = toolInput.path as string | undefined;
      if (searchPath) files.push(makeFileAccess(searchPath, 'read', eventId, toolName, timestamp));
      break;
    }
    case 'WebFetch': {
      const url = toolInput.url as string | undefined;
      if (url) {
        const access = makeUrlAccess(
          url, eventId, toolName, timestamp,
          estimateBytes(toolOutput),
          estimateBytes(toolInput)
        );
        if (access) urls.push(access);
      }
      break;
    }
    case 'WebSearch': {
      const query = toolInput.query as string | undefined;
      if (query) {
        urls.push({
          url: `search://${query}`,
          hostname: 'web-search',
          eventId,
          toolName,
          timestamp,
          bytesIn: estimateBytes(toolOutput),
          bytesOut: estimateBytes(toolInput),
        });
      }
      break;
    }
    default: {
      // MCP tools or other tools with url parameter
      if (toolName.startsWith('mcp__')) {
        const url = toolInput.url as string | undefined;
        if (url) {
          const access = makeUrlAccess(
            url, eventId, toolName, timestamp,
            estimateBytes(toolOutput),
            estimateBytes(toolInput)
          );
          if (access) urls.push(access);
        }
      }
      break;
    }
  }

  return { files, urls };
}
