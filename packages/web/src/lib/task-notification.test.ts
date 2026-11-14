import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

describe('task-notification', () => {
  it('is byte-identical to the server copy', () => {
    expect(readFileSync(join(here, 'task-notification.ts'), 'utf8')).toBe(
      readFileSync(join(here, '../../../server/src/events/task-notification.ts'), 'utf8'),
    );
  });
});
