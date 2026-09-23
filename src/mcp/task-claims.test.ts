import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hive } from '../server/hive.ts';
import { startServer } from '../server/serve.ts';
import type { TaskSnapshot } from '../shared/tasks.ts';

test('real MCP claim retries and CLI release share one versioned advisory ledger', { timeout: 20000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-claim-clients-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const server = startServer({ hive, port: 0, telegram: false });
  const client = new Client({ name: 'claim-fixture', version: '1' });
  let transport: StdioClientTransport | undefined;
  try {
    const port = await server.ready;
    const brain = hive.identity.join({ role: 'brain' }), worker = hive.identity.join({ role: 'worker', seniority: 'mid' });
    const task = hive.tasks.assign(brain.agent, { requestId: 'fixture', worker: worker.agent.name,
      contract: { objective: 'Check advisory fixture', scope: [], nonGoals: [], acceptanceCriteria: ['Inspected'], dependencies: [], evidenceSeqs: [] } }).task;
    const env = { PATH: process.env.PATH ?? '', HIVEMIND_TOKEN: brain.token, HIVEMIND_HOME: path.join(dir, 'client'), HIVEMIND_URL: `http://127.0.0.1:${port}` };
    const args = ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'src/cli.ts')];
    transport = new StdioClientTransport({ command: process.execPath, args: [...args, 'mcp'], env, cwd: dir, stderr: 'pipe' });
    await client.connect(transport, { signal: t.signal, timeout: 5000 });
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: arguments_ }, CallToolResultSchema, { timeout: 5000, signal: t.signal }));
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const item = result.content.find(item => item.type === 'text'); assert.ok(item?.type === 'text');
      return JSON.parse(item.text) as { task: TaskSnapshot; duplicate?: boolean; message?: { id: string } };
    };
    const input = { taskId: task.id, requestId: 'one-claim', expectedRevision: 1,
      action: { type: 'claim', leaseSeconds: 60, paths: ['src/parser'], overlapAcknowledgements: [] } };
    const preview = CallToolResultSchema.parse(await client.callTool({ name: 'preview_task_claim', arguments: { taskId: task.id, paths: ['src/parser'] } }, CallToolResultSchema, { timeout: 5000, signal: t.signal }));
    assert.notEqual(preview.isError, true, JSON.stringify(preview));
    const previewContent = preview.content[0]; assert.ok(previewContent?.type === 'text');
    assert.deepEqual(JSON.parse(previewContent.text).overlaps, []);
    assert.equal(hive.tasks.get(brain.agent, task.id).revision, 1);
    const first = await call('task_event', input), replay = await call('task_event', input);
    assert.equal(first.task.claim!.version, 1); assert.equal(first.task.state, 'sent');
    assert.equal(replay.duplicate, true); assert.equal(replay.message!.id, first.message!.id);
    const file = path.join(dir, 'release.json');
    writeFileSync(file, JSON.stringify({ requestId: 'one-release', expectedRevision: 2,
      action: { type: 'release_claim', reason: 'Confirmed no more advisory intent' } }), { mode: 0o600 });
    const cli = await promisify(execFile)(process.execPath, [...args, 'task', 'event', '--id', task.id, '--input', file], { cwd: dir, env, timeout: 5000 });
    const released = JSON.parse(cli.stdout) as { task: TaskSnapshot };
    assert.equal(released.task.claim!.version, 2); assert.equal(released.task.claim!.state, 'released');
    assert.equal((await call('get_task', { taskId: task.id })).task.claim!.version, 2);
    assert.equal(hive.tasks.get(worker.agent, task.id).workerId, worker.agent.id);
  } finally {
    try { await client.close(); await transport?.close(); }
    finally { await server.shutdown(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});
