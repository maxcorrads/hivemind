import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hive } from '../server/hive.ts';
import { startServer } from '../server/serve.ts';
import type { HandoffList } from '../shared/handoffs.ts';
import { childEnv } from '../test-support/child-process.ts';

test('fresh real stdio and CLI sessions recover bounded handoffs without token disclosure or state transitions', { timeout: 20_000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-handoff-clients-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const server = startServer({ port: 0, hive, telegram: false });
  const clients: Client[] = [];
  t.after(async () => {
    try { for (const client of clients) await client.close(); }
    finally { try { await server.shutdown(); } finally { hive.db.close(); rmSync(dir, { recursive: true, force: true }); } }
  });
  const port = await server.ready;
  const brain = hive.identity.join({ role: 'brain' }), worker = hive.identity.join({ role: 'worker', seniority: 'mid' });
  const task = hive.tasks.assign(brain.agent, { requestId: 'handoff-assignment', worker: worker.agent.name,
    contract: { objective: 'Repair parser', scope: ['parser'], nonGoals: [], acceptanceCriteria: ['Regression test'], dependencies: [], evidenceSeqs: [] } }).task;
  hive.tasks.event(worker.agent, task.id, { requestId: 'accept', expectedRevision: 1, action: { type: 'accept' } });
  const env = childEnv({ PATH: process.env.PATH ?? '', HIVEMIND_TOKEN: worker.token,
    HIVEMIND_HOME: path.join(dir, 'identities'), HIVEMIND_URL: `http://127.0.0.1:${port}` });
  const args = ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'src/cli.ts')];
  const connect = async () => {
    const client = new Client({ name: 'handoff-fixture', version: '1' }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [...args, 'mcp'], cwd: dir, env, stderr: 'pipe' }), { signal: t.signal });
    return client;
  };
  const call = async <T>(client: Client, name: string, input = {}): Promise<T> => {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: input }, CallToolResultSchema, { timeout: 5000, signal: t.signal }));
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const content = result.content.find(item => item.type === 'text'); assert.ok(content && content.type === 'text');
    assert.ok(!content.text.includes(worker.token));
    return JSON.parse(content.text) as T;
  };
  const client = await connect();
  const checkpoint = { requestId: 'saved-report', taskId: task.id, expectedRevision: 2,
    action: { type: 'checkpoint', checkpoint: { completedSteps: ['Failure reproduced'], unresolvedQuestions: [],
      nextAction: 'Add the empty input guard', artifacts: ['src/parser.ts'], checks: [], evidenceSeqs: [] } } };
  await call(client, 'task_event', checkpoint);
  await client.close();
  const resumed = await connect();
  const joined = await call<{ handoffs: HandoffList; next: string }>(resumed, 'join', { role: 'worker', project: 'acme' });
  assert.equal(joined.handoffs.items[0]?.taskId, task.id);
  assert.equal(joined.handoffs.items[0]?.nextAction, 'Add the empty input guard');
  assert.match(joined.next, /get_handoffs with taskId/);
  const recovered = await call<ReturnType<Hive['tasks']['handoff']>>(resumed, 'get_handoffs', { taskId: task.id });
  assert.equal(recovered.freshness, 'current');
  assert.equal(recovered.checkpoint?.version, 1);
  assert.equal(recovered.state, 'accepted');
  assert.equal((await call<HandoffList>(resumed, 'get_handoffs')).items[0]?.taskId, task.id);
  const both = await resumed.callTool({ name: 'get_handoffs', arguments: { taskId: task.id, beforeTask: task.id } });
  assert.equal(both.isError, true);
  assert.match(JSON.stringify(both.content), /not both/);
  assert.equal((await call<{ duplicate: boolean }>(resumed, 'task_event', checkpoint)).duplicate, true);
  const cli = await promisify(execFile)(process.execPath, [...args, 'task', 'handoff', '--id', task.id], { cwd: dir, env, timeout: 8000 });
  assert.equal(JSON.parse(cli.stdout).checkpoint.messageId, recovered.checkpoint?.messageId);
  const list = await promisify(execFile)(process.execPath, [...args, 'task', 'handoffs'], { cwd: dir, env, timeout: 8000 });
  assert.equal(JSON.parse(list.stdout).items[0].taskId, task.id);
  assert.equal(hive.tasks.get(worker.agent, task.id).revision, 3);
  assert.equal(hive.tasks.get(worker.agent, task.id).state, 'accepted');
});
