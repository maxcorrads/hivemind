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
import { Hive } from '../server/hive.ts';
import { startServer } from '../server/serve.ts';

test('real MCP clients assign/receive/accept/result/review and CLI reads the same durable task', { timeout: 25_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-task-clients-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const server = startServer({ port: 0, hive, telegram: false }); const port = await server.ready;
  const brain = hive.join({ role: 'brain' }), worker = hive.join({ role: 'worker', seniority: 'mid' });
  const clients: Client[] = [];
  const env = (token: string) => ({ PATH: process.env.PATH ?? '', HIVEMIND_TOKEN: token,
    HIVEMIND_HOME: path.join(dir, 'identities'), HIVEMIND_URL: `http://127.0.0.1:${port}` });
  const args = ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'src/cli.ts')];
  const connect = async (token: string) => {
    const client = new Client({ name: 'task-fixture', version: '1' }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [...args, 'mcp'], cwd: dir, env: env(token), stderr: 'pipe' }));
    return client;
  };
  const call = async (client: Client, name: string, input: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: input }); assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse((result.content as { type: string; text: string }[]).find(c => c.type === 'text')!.text);
  };
  try {
    const assigner = await connect(brain.token), assignee = await connect(worker.token);
    const assigned = await call(assigner, 'assign_task', { requestId: 'mcp-assignment', worker: worker.agent.name,
      contract: { objective: 'Check parser fixture', scope: ['Parser'], nonGoals: ['No deployment'], acceptanceCriteria: ['Tests pass'], dependencies: [], evidenceSeqs: [] } });
    const taskId = assigned.task.id;
    const mail = await call(assignee, 'wait', {});
    assert.equal(mail.mail[0].taskEvent.taskId, taskId);
    await call(assignee, 'ack_delivery', { deliveryId: mail.delivery.id });
    assert.equal((await call(assigner, 'get_task', { taskId })).task.state, 'delivered');
    await call(assignee, 'task_event', { taskId, requestId: 'mcp-accept', expectedRevision: 1, action: { type: 'accept' } });
    await call(assignee, 'task_event', { taskId, requestId: 'mcp-result', expectedRevision: 2, action: { type: 'result', result: {
      summary: 'Parser checked', artifacts: [], checks: [{ name: 'fixture tests', outcome: 'passed', evidenceSeqs: [] }], gaps: [], evidenceSeqs: [] } } });
    const beforeReview = await call(assigner, 'get_task', { taskId }); assert.equal(beforeReview.task.state, 'result_submitted');
    const workerReview = await assignee.callTool({ name: 'task_event', arguments: { taskId, requestId: 'self-review', expectedRevision: 3,
      action: { type: 'review', decision: 'accepted', summary: 'Self review', evidenceSeqs: [] } } });
    assert.equal(workerReview.isError, true);
    await call(assigner, 'task_event', { taskId, requestId: 'mcp-review', expectedRevision: 3,
      action: { type: 'review', decision: 'accepted', summary: 'Evidence checked', evidenceSeqs: [] } });
    const cli = await promisify(execFile)(process.execPath, [...args, 'task', 'get', '--id', taskId], { cwd: dir, env: env(brain.token), timeout: 10000 });
    assert.equal(JSON.parse(cli.stdout).task.state, 'accepted_complete');
    assert.equal(hive.listMessages(brain.agent, assigned.task.channelId, { threadId: taskId }).messages.filter(m => m.taskEvent).length, 4);
  } finally {
    for (const client of clients) await client.close();
    server.shutdown(); server.server.closeAllConnections(); hive.db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
