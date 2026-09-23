import type { TaskSnapshot } from '../shared/tasks.ts';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Hive } from '../server/hive.ts';
import { startServer } from '../server/serve.ts';
import { childEnv } from '../test-support/child-process.ts';

test('real stdio MCP preserves HTTP task/room payloads across client reconnect and enforces project/actor scope', { timeout: 20000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-coordination-mcp-'));
  const hive = new Hive(path.join(dir, 'hive.db')), server = startServer({ port: 0, hive, telegram: false });
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    const closed = server.server.listening ? once(server.server, 'close') : Promise.resolve();
    server.shutdown(); server.server.closeAllConnections(); await closed;
    hive.db.close(); rmSync(dir, { recursive: true, force: true });
  });
  const port = await server.ready, url = `http://127.0.0.1:${port}`;
  const human = hive.identity.getAgent('human'), brain = hive.identity.join({ role: 'brain' }), worker = hive.identity.join({ role: 'worker', seniority: 'mid' });
  const other = hive.projects.createProject(human, { name: 'Other MCP fixture', slug: 'other-mcp-fixture' });
  const foreign = hive.identity.join({ role: 'brain', project: other.slug });
  const channel = hive.channels.createChannel(brain.agent, { name: 'contract-fixture', type: 'private', memberNames: [worker.agent.name] });
  hive.rooms.event(human, channel.id, { requestId: 'setup', expectedRevision: 0, action: { type: 'configure', reason: 'Fixture',
    contract: { mode: 'ongoing', purpose: 'Private shared fixture', rules: ['Inspect only'], limits: ['No external writes'],
      coordinator: brain.agent.name, participants: [{ name: worker.agent.name, boundary: 'Inspect' }], completion: ['Human archives'], originTaskId: null } } });
  const assigned = hive.tasks.assign(brain.agent, { requestId: 'assign', channel: channel.id, worker: worker.agent.name,
    room: { contractVersion: 1, actionKey: 'fixture-1' }, contract: { objective: 'Private fixture objective', scope: ['Fixture'], nonGoals: [],
      acceptanceCriteria: ['Report reviewed result'], dependencies: [], evidenceSeqs: [] } });
  hive.rooms.event(worker.agent, channel.id, { requestId: 'rules', expectedRevision: 1, action: { type: 'acknowledge', contractVersion: 1 } });
  hive.tasks.event(worker.agent, assigned.task.id, { requestId: 'accept', expectedRevision: 1, action: { type: 'accept' } });
  const connect = async (token: string) => {
    const client = new Client({ name: 'coordination-wire-fixture', version: '1' }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'src/cli.ts'), 'mcp'], cwd: dir,
      env: childEnv({ PATH: process.env.PATH ?? '', HIVEMIND_TOKEN: token, HIVEMIND_HOME: path.join(dir, 'identities'), HIVEMIND_URL: url }), stderr: 'pipe' }));
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const text = (result.content as Array<{ type: string; text: string }>).find(item => item.type === 'text');
    assert.ok(text); return JSON.parse(text.text);
  };
  const http = async <T = unknown>(route: string, token: string): Promise<T> => {
    const response = await fetch(url + route, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); return await response.json() as T;
  };
  const taskUrl = `/api/agent/tasks/${assigned.task.id}`, roomUrl = `/api/agent/channels/${channel.id}/room`;
  const first = await connect(worker.token);
  const task = await http<{ task: TaskSnapshot }>(taskUrl, worker.token), room = await http(roomUrl, worker.token);
  assert.deepEqual(await call(first, 'get_task', { taskId: assigned.task.id }), task);
  assert.deepEqual(await call(first, 'get_room', { channel: channel.id }), room);
  assert.deepEqual(await call(first, 'get_room', { channel: channel.id, history: true }), await http(roomUrl + '/history', worker.token));
  assert.equal(task.task.state, 'accepted'); assert.ok(task.task.room); assert.equal(task.task.room.acknowledged, true);
  await first.close();
  const resumed = await connect(worker.token);
  assert.deepEqual(await call(resumed, 'get_task', { taskId: assigned.task.id }), task);
  assert.deepEqual(await call(resumed, 'get_room', { channel: channel.id }), room);
  const wrongProject = await connect(foreign.token);
  for (const [name, args] of [['get_task', { taskId: assigned.task.id }], ['get_room', { channel: channel.id }]] as const) {
    const result = await wrongProject.callTool({ name, arguments: args });
    assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes('Private fixture objective'));
  }
  const forged = await resumed.callTool({ name: 'task_event', arguments: { taskId: assigned.task.id, requestId: 'forged-review', expectedRevision: 2,
    action: { type: 'review', decision: 'accepted', summary: 'Worker is not the reviewer', evidenceSeqs: [] } } });
  assert.equal(forged.isError, true);
  assert.deepEqual(await http(taskUrl, worker.token), task);
});
