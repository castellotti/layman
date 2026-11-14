import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify from 'fastify';
import { registerHookHandler } from './handler.js';
import { PendingApprovalManager } from './pending.js';
import { SessionGate } from './gate.js';
import { EventStore } from '../events/store.js';
import { AnalysisEngine } from '../analysis/engine.js';
import { LaymanConfigSchema } from '../config/schema.js';

function harness() {
  const app = Fastify();
  const store = new EventStore();
  const gate = new SessionGate();
  const config = LaymanConfigSchema.parse({ autoApprove: 'none' });
  registerHookHandler(app, new PendingApprovalManager(1), store, new AnalysisEngine(), () => config, gate);
  gate.activate('s1');
  return { app, store };
}

const body = (extra: Record<string, unknown>) => ({
  session_id: 's1',
  cwd: '/p',
  hook_event_name: 'PostModelSwitch',
  transcript_path: '/tmp/t.jsonl',
  permission_mode: 'default',
  ...extra,
});

describe('PostModelSwitch', () => {
  it('records a model_change with both models', async () => {
    const h = harness();
    const res = await h.app.inject({ method: 'POST', url: '/hooks/PostModelSwitch', payload: body({ from_model: 'claude-opus-5', to_model: 'claude-sonnet-5-5' }) });
    expect(res.statusCode).toBe(200);
    const [e] = h.store.getAll().filter((x) => x.type === 'model_change');
    expect(e.data.fromModel).toBe('claude-opus-5');
    expect(e.data.toModel).toBe('claude-sonnet-5-5');
  });

  it('records nothing without a destination', async () => {
    const h = harness();
    await h.app.inject({ method: 'POST', url: '/hooks/PostModelSwitch', payload: body({ from_model: 'x' }) });
    expect(h.store.getAll().filter((x) => x.type === 'model_change')).toHaveLength(0);
  });
});

describe('a model change seen in the transcript', () => {
  const line = (uuid: string, model: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'assistant', uuid, message: { model, content: [{ type: 'text', text: `from ${uuid}` }] }, ...extra }) + '\n';
  let n = 0;

  async function stop(h: ReturnType<typeof harness>, path: string, session = 's1') {
    await h.app.inject({ method: 'POST', url: '/hooks/Stop', payload: { ...body({ hook_event_name: 'Stop', transcript_path: path }), session_id: session } });
  }
  const changes = (h: ReturnType<typeof harness>) => h.store.getAll().filter((x) => x.type === 'model_change').map((x) => `${x.data.fromModel}>${x.data.toModel}`);

  it('is recorded once, never for the same model, a subagent or a synthetic message', async () => {
    const h = harness();
    const path = join(mkdtempSync(join(tmpdir(), 'tr-')), `t${n++}.jsonl`);
    writeFileSync(path, line('u1', 'opus'));
    await stop(h, path); // first sight: seeds the watermark and the model
    appendFileSync(path, line('u2', 'opus') + line('u3', 'haiku', { isSidechain: true }) + line('u4', '<synthetic>'));
    await stop(h, path);
    expect(changes(h)).toEqual([]);
    appendFileSync(path, line('u5', 'sonnet') + line('u6', 'sonnet'));
    await stop(h, path);
    expect(changes(h)).toEqual(['opus>sonnet']);
  });

  it('is not recorded again when PostModelSwitch already said so', async () => {
    const h = harness();
    const path = join(mkdtempSync(join(tmpdir(), 'tr-')), `t${n++}.jsonl`);
    writeFileSync(path, line('u1', 'opus'));
    await stop(h, path);
    await h.app.inject({ method: 'POST', url: '/hooks/PostModelSwitch', payload: body({ from_model: 'opus', to_model: 'sonnet' }) });
    appendFileSync(path, line('u2', 'sonnet'));
    await stop(h, path);
    expect(changes(h)).toEqual(['opus>sonnet']);
  });
});
