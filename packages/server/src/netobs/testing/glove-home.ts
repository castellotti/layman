/**
 * A glove v3 home for tests, shaped like glove's own (`registry.json` v2,
 * `observe/<id>/net/`, `control/<id>/` only with the filter grant, and the
 * session directory with its `.glove/id`, so the session is not an orphan).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** A glove v3 session id, as the fixtures use. */
export const TEST_ID = 'pi-search-0f1a2b';

export interface TestSessionOptions {
  /** The filter grant: creates `control/<id>/`. Default true. */
  filter?: boolean;
  /** Export transcripts too (`observe/<id>/transcripts/`). Default false. */
  transcripts?: boolean;
  harness?: string;
  /** Write a registry row. Default true; false makes an orphan (no row). */
  registered?: boolean;
}

export interface TestSession {
  id: string;
  net: string;
  control: string;
  transcripts: string;
  /** The session directory the registry row names. */
  dir: string;
}

export function addGloveSession(home: string, id = TEST_ID, opts: TestSessionOptions = {}): TestSession {
  const { filter = true, transcripts = false, harness = 'pi', registered = true } = opts;
  const exportDir = join(home, 'observe', id);
  const net = join(exportDir, 'net');
  const control = join(home, 'control', id);
  const dir = join(home, 'sessions', id);
  mkdirSync(net, { recursive: true });
  mkdirSync(join(home, 'control'), { recursive: true });
  if (filter) mkdirSync(control, { recursive: true });
  if (transcripts) mkdirSync(join(exportDir, 'transcripts'), { recursive: true });
  mkdirSync(join(dir, '.glove'), { recursive: true });
  writeFileSync(join(dir, '.glove', 'id'), `${id}\n`);
  if (registered) {
    registerRow(home, {
      id, dir, harness, template: 'pi-search', created: '2026-10-01T12:00:00.000Z', subnet: '172.31.0.0/24',
      grants: {
        observe: { net: true, transcripts },
        filter: filter ? { granted: true, since: '2026-10-01T12:00:00.000Z' } : { granted: false },
      },
    });
  }
  return { id, net, control, transcripts: join(exportDir, 'transcripts'), dir };
}

/** Add or replace one row of `<home>/registry.json` (v2). */
export function registerRow(home: string, row: Record<string, unknown> & { id: string }): void {
  const path = join(home, 'registry.json');
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = (JSON.parse(readFileSync(path, 'utf8')) as { sessions: Array<Record<string, unknown>> }).sessions;
  } catch { /* none yet */ }
  mkdirSync(home, { recursive: true });
  writeFileSync(path, JSON.stringify({ v: 2, sessions: [...rows.filter((r) => r.id !== row.id), row] }, null, 2) + '\n');
}

/** A v2 fixture's `env`/`session` values rewritten to a v3 id (both are the id in glove v3). */
export function asId(text: string, id: string): string {
  return text
    .replace(/"env": *"[^"]*"/g, (m) => m.replace(/"[^"]*"$/, `"${id}"`))
    .replace(/"session": *"[^"]*"/g, (m) => m.replace(/"[^"]*"$/, `"${id}"`));
}
