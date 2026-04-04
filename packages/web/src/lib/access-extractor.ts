import type { TimelineEvent, FileAccess, UrlAccess, SessionAccessLog } from './types.js';

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

const RM_PATTERN = /\brm\s+(?:-[a-zA-Z]*\s+)*([^\s;|&>]+)/g;

/** Extract access log from a list of timeline events (for historical sessions). */
export function extractAccessFromEvents(events: TimelineEvent[]): SessionAccessLog {
  const files: FileAccess[] = [];
  const urls: UrlAccess[] = [];

  for (const event of events) {
    // If the event already has extracted access data, use it
    if (event.data.fileAccess) {
      files.push(...event.data.fileAccess);
      continue;
    }
    if (event.data.urlAccess) {
      urls.push(...event.data.urlAccess);
    }

    const toolName = event.data.toolName;
    const toolInput = event.data.toolInput;
    if (!toolName || !toolInput) continue;

    const filePath = toolInput.file_path as string | undefined;
    const eventId = event.id;
    const timestamp = event.timestamp;

    switch (toolName) {
      case 'Read':
        if (filePath) files.push({ path: filePath, filename: basename(filePath), operation: 'read', eventId, toolName, timestamp });
        break;
      case 'Write':
        if (filePath) files.push({ path: filePath, filename: basename(filePath), operation: 'wrote', eventId, toolName, timestamp });
        break;
      case 'Edit':
      case 'MultiEdit':
        if (filePath) files.push({ path: filePath, filename: basename(filePath), operation: 'edited', eventId, toolName, timestamp });
        break;
      case 'Bash': {
        const command = (toolInput.command as string) ?? '';
        let match: RegExpExecArray | null;
        RM_PATTERN.lastIndex = 0;
        while ((match = RM_PATTERN.exec(command)) !== null) {
          const path = match[1];
          if (path && !path.startsWith('-')) {
            files.push({ path, filename: basename(path), operation: 'deleted', eventId, toolName, timestamp });
          }
        }
        break;
      }
      case 'Glob':
      case 'Grep': {
        const searchPath = toolInput.path as string | undefined;
        if (searchPath) files.push({ path: searchPath, filename: basename(searchPath), operation: 'read', eventId, toolName, timestamp });
        break;
      }
      case 'WebFetch': {
        const url = toolInput.url as string | undefined;
        if (url) {
          const hostname = tryParseHostname(url);
          if (hostname) urls.push({ url, hostname, eventId, toolName, timestamp });
        }
        break;
      }
      case 'WebSearch': {
        const query = toolInput.query as string | undefined;
        if (query) urls.push({ url: `search://${query}`, hostname: 'web-search', eventId, toolName, timestamp });
        break;
      }
      default: {
        if (toolName.startsWith('mcp__')) {
          const url = toolInput.url as string | undefined;
          if (url) {
            const hostname = tryParseHostname(url);
            if (hostname) urls.push({ url, hostname, eventId, toolName, timestamp });
          }
        }
        break;
      }
    }
  }

  return { files, urls };
}
