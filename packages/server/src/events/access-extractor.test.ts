import { describe, it, expect } from 'vitest';
import { extractAccess } from './access-extractor.js';

describe('extractAccess', () => {
  const eventId = 'test-event-id';
  const timestamp = 1700000000000;

  describe('file operations', () => {
    it('extracts Read as read operation', () => {
      const result = extractAccess('Read', { file_path: '/src/app.ts' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toEqual({
        path: '/src/app.ts',
        filename: 'app.ts',
        operation: 'read',
        eventId,
        toolName: 'Read',
        timestamp,
      });
    });

    it('extracts Write as wrote operation', () => {
      const result = extractAccess('Write', { file_path: '/tmp/out.txt', content: 'hello' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].operation).toBe('wrote');
      expect(result.files[0].filename).toBe('out.txt');
    });

    it('extracts Edit as edited operation', () => {
      const result = extractAccess('Edit', { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].operation).toBe('edited');
    });

    it('extracts MultiEdit as edited operation', () => {
      const result = extractAccess('MultiEdit', { file_path: 'src/index.ts' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].operation).toBe('edited');
    });

    it('extracts rm from Bash as deleted operation', () => {
      const result = extractAccess('Bash', { command: 'rm /tmp/test.txt' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].operation).toBe('deleted');
      expect(result.files[0].path).toBe('/tmp/test.txt');
    });

    it('extracts rm -rf from Bash', () => {
      const result = extractAccess('Bash', { command: 'rm -rf /tmp/build' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe('/tmp/build');
    });

    it('returns empty for Bash without rm', () => {
      const result = extractAccess('Bash', { command: 'ls -la /tmp' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(0);
    });

    it('extracts output redirect (>) as wrote', () => {
      const result = extractAccess('Bash', { command: 'echo hello > /tmp/out.txt' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].operation).toBe('wrote');
      expect(result.files[0].path).toBe('/tmp/out.txt');
    });

    it('extracts append redirect (>>) as edited', () => {
      const result = extractAccess('Bash', { command: 'echo hello >> /tmp/log.txt' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].operation).toBe('edited');
      expect(result.files[0].path).toBe('/tmp/log.txt');
    });

    it('ignores /dev/null redirect', () => {
      const result = extractAccess('Bash', { command: 'command > /dev/null' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(0);
    });

    it('extracts cat file as read', () => {
      const result = extractAccess('Bash', { command: 'cat /etc/hosts' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].operation).toBe('read');
      expect(result.files[0].path).toBe('/etc/hosts');
    });

    it('cat with heredoc produces single wrote entry, no reads', () => {
      const cmd = "cat > /tmp/out.txt << 'EOF'\nline1\nline2\nEOF";
      const result = extractAccess('Bash', { command: cmd }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].operation).toBe('wrote');
      expect(result.files[0].path).toBe('/tmp/out.txt');
    });

    it('cat heredoc with paths in body does not produce spurious reads', () => {
      const cmd = "cat > /tmp/out.txt << 'EOF'\n/some/absolute/path\n/another/path\nEOF";
      const result = extractAccess('Bash', { command: cmd }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].operation).toBe('wrote');
      expect(result.files[0].path).toBe('/tmp/out.txt');
    });

    it('cat heredoc with unquoted delimiter', () => {
      const cmd = "cat > /tmp/config.json << HEREDOC\n{\"key\": \"value\"}\nHEREDOC";
      const result = extractAccess('Bash', { command: cmd }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].operation).toBe('wrote');
      expect(result.files[0].path).toBe('/tmp/config.json');
    });

    it('extracts head/tail with flags as read', () => {
      const result = extractAccess('Bash', { command: 'head -n 10 /var/log/app.log' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].operation).toBe('read');
      expect(result.files[0].path).toBe('/var/log/app.log');
    });

    it('extracts Glob search path as read', () => {
      const result = extractAccess('Glob', { pattern: '**/*.ts', path: '/src' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].operation).toBe('read');
      expect(result.files[0].path).toBe('/src');
    });

    it('extracts Grep search path as read', () => {
      const result = extractAccess('Grep', { pattern: 'import', path: './src' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].operation).toBe('read');
    });

    it('returns empty for Glob without path', () => {
      const result = extractAccess('Glob', { pattern: '**/*.ts' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(0);
    });
  });

  describe('URL operations', () => {
    it('extracts WebFetch URL', () => {
      const result = extractAccess('WebFetch', { url: 'https://api.example.com/data' }, '{"ok":true}', eventId, timestamp);
      expect(result.urls).toHaveLength(1);
      expect(result.urls[0].hostname).toBe('api.example.com');
      expect(result.urls[0].url).toBe('https://api.example.com/data');
      expect(result.urls[0].bytesIn).toBeDefined();
      expect(result.urls[0].bytesOut).toBeDefined();
    });

    it('extracts WebSearch query as search URL', () => {
      const result = extractAccess('WebSearch', { query: 'fastify websocket' }, undefined, eventId, timestamp);
      expect(result.urls).toHaveLength(1);
      expect(result.urls[0].url).toBe('search://fastify websocket');
    });

    it('extracts MCP tool URL', () => {
      const result = extractAccess('mcp__plugin__fetch', { url: 'https://docs.example.com' }, undefined, eventId, timestamp);
      expect(result.urls).toHaveLength(1);
      expect(result.urls[0].hostname).toBe('docs.example.com');
    });

    it('ignores non-MCP tools without url', () => {
      const result = extractAccess('SomeOtherTool', { data: 'test' }, undefined, eventId, timestamp);
      expect(result.urls).toHaveLength(0);
      expect(result.files).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('handles undefined toolInput', () => {
      const result = extractAccess('Read', undefined, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(0);
      expect(result.urls).toHaveLength(0);
    });

    it('handles missing file_path', () => {
      const result = extractAccess('Read', {}, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(0);
    });

    it('handles invalid URL in WebFetch', () => {
      const result = extractAccess('WebFetch', { url: 'not-a-url' }, undefined, eventId, timestamp);
      expect(result.urls).toHaveLength(0);
    });

    it('handles multiple rm targets in one command', () => {
      const result = extractAccess('Bash', { command: 'rm /tmp/a.txt && rm /tmp/b.txt' }, undefined, eventId, timestamp);
      expect(result.files).toHaveLength(2);
    });
  });
});
