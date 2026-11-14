import { describe, it, expect } from 'vitest';
import { backgroundTaskIdOf, isTaskNotification, parseTaskNotification } from './task-notification.js';

const NOTE = `<task-notification>
<task-id>a29eb3475838042e2</task-id>
<tool-use-id>toolu_01Pc38</tool-use-id>
<output-file>/tmp/x.output</output-file>
<status>completed</status>
<summary>Agent "x" completed</summary>
<result>done <task-id>not-this</task-id></result>
</task-notification>`;

describe('task notifications', () => {
  it('recognises the harness message, not a user quoting it later', () => {
    expect(isTaskNotification(NOTE)).toBe(true);
    expect(isTaskNotification('  \n' + NOTE)).toBe(true);
    expect(isTaskNotification('what is a <task-notification> ?')).toBe(false);
    expect(isTaskNotification(undefined)).toBe(false);
  });
  it('reads its first ids and status', () => {
    expect(parseTaskNotification(NOTE)).toEqual({ taskId: 'a29eb3475838042e2', toolUseId: 'toolu_01Pc38', status: 'completed' });
    expect(parseTaskNotification('<task-notification>\n<task-id>b1</task-id>\n</task-notification>')).toEqual({ taskId: 'b1', toolUseId: undefined, status: undefined });
    expect(parseTaskNotification('hello')).toBeNull();
  });
  it('finds a started task id only for a call that asked for the background', () => {
    const agent = 'Async agent launched successfully.\nagentId: a238ba3e7bd3030bc (internal ID)';
    const bash = 'Command running in background with ID: b0bd0ju6r. Output is being written to: /tmp/x';
    expect(backgroundTaskIdOf({ run_in_background: true }, agent)).toBe('a238ba3e7bd3030bc');
    expect(backgroundTaskIdOf({ run_in_background: true }, bash)).toBe('b0bd0ju6r');
    expect(backgroundTaskIdOf({ background: true }, { stdout: bash })).toBe('b0bd0ju6r');
    expect(backgroundTaskIdOf({ command: 'ls' }, bash)).toBeUndefined();
    expect(backgroundTaskIdOf({ run_in_background: true }, 'nothing useful')).toBeUndefined();
    expect(backgroundTaskIdOf(null, bash)).toBeUndefined();
  });
});
