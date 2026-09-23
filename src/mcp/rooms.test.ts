import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Hive } from '../server/hive.ts';
import { startServer } from '../server/serve.ts';

test('real MCP and CLI room lifecycle shares durable rules, task fences, source state and ACKs', { timeout: 30000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-room-clients-'));
  const hive = new Hive(path.join(dir, 'hive.db')), server = startServer({ port: 0, hive, telegram: false });
  const port = await server.ready, clients: Client[] = [];
  const brain = hive.identity.join({ role: 'brain' }), worker = hive.identity.join({ role: 'worker', seniority: 'mid' });
  const channel = hive.channels.createChannel(brain.agent, { name: 'generic-events', type: 'private', memberNames: [worker.agent.name] });
  const humanInstructionSeq = hive.messages.postMessage(hive.identity.getAgent('human'), { channel: channel.id, body: 'Follow synthetic events and ask the worker to inspect anomalies. No external writes.' }).seq;
  const env = (token: string) => ({ PATH: process.env.PATH ?? '', HIVEMIND_TOKEN: token, HIVEMIND_HOME: path.join(dir, 'identities'), HIVEMIND_URL: `http://127.0.0.1:${port}` });
  const args = ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'src/cli.ts')];
  const connect = async (token: string) => {
    const client = new Client({ name: 'room-fixture', version: '1' }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [...args, 'mcp'], cwd: dir, env: env(token), stderr: 'pipe' })); return client;
  };
  const call = async (client: Client, name: string, input: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: input }); assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse((result.content as { type: string; text: string }[]).find(c => c.type === 'text')!.text);
  };
  try {
    const b = await connect(brain.token), w = await connect(worker.token);
    const sendDescription = (await b.listTools()).tools.find(t => t.name === 'send')!.description!;
    // Retry rules live in the standing orders; the description only points there.
    assert.match(sendDescription, /requestId makes retries idempotent for 24 hours \(rules in standing orders\)/);
    assert.doesNotMatch(sendDescription, /failed call did not deliver/);
    const created = await call(b, 'room_event', { channel: channel.id, requestId: 'setup', expectedRevision: 0, humanInstructionSeq,
      action: { type: 'configure', reason: 'Human requested ongoing checks', contract: { mode: 'ongoing', purpose: 'Inspect synthetic anomalies',
        rules: ['Assign an anomaly check'], limits: ['No external writes'], coordinator: brain.agent.name,
        participants: [{ name: worker.agent.name, boundary: 'Fixture analysis' }], completion: ['Human archives'], originTaskId: null } } });
    assert.equal(created.room.contractVersion, 1);
    const mail = await call(w, 'wait', {}); await call(w, 'ack_delivery', { deliveryId: mail.delivery.id });
    const current = await call(w, 'get_room', { channel: `#${channel.name}` });
    await call(w, 'room_event', { channel: `#${channel.name}`, requestId: 'rules-ack', expectedRevision: current.room.revision, action: { type: 'acknowledge', contractVersion: 1 } });
    const assigned = await call(b, 'assign_task', { requestId: 'work', worker: worker.agent.name, channel: channel.id,
      room: { contractVersion: 1, actionKey: 'fixture-anomaly-1' }, contract: { objective: 'Inspect anomaly 1', scope: ['Fixture'], nonGoals: [], acceptanceCriteria: ['Report value'], dependencies: [], evidenceSeqs: [] } });
    const delivery = await call(w, 'wait', {}); await call(w, 'ack_delivery', { deliveryId: delivery.delivery.id });
    await call(w, 'task_event', { taskId: assigned.task.id, requestId: 'accept', expectedRevision: 1, action: { type: 'accept' } });
    const file = path.join(dir, 'archive.json'); writeFileSync(file, JSON.stringify({ requestId: 'cli-archive', expectedRevision: hive.rooms.peek(channel.id)!.revision,
      humanInstructionSeq: hive.messages.postMessage(hive.identity.getAgent('human'), { channel: channel.id, body: 'Archive and request interruption.' }).seq,
      action: { type: 'archive', running: 'stop', reason: 'Human ended monitoring' } }));
    const cli = await promisify(execFile)(process.execPath, [...args, 'room', 'event', '--channel', channel.id, '--input', file], { cwd: dir, env: env(brain.token), timeout: 10000 });
    assert.equal(JSON.parse(cli.stdout).room.state, 'archived');
    const stopped = await call(w, 'get_task', { taskId: assigned.task.id }); assert.equal(stopped.task.room.status, 'stop_requested');
    const room = await call(w, 'get_room', { channel: channel.id });
    await call(w, 'room_event', { channel: channel.id, requestId: 'stopped', expectedRevision: room.room.revision, action: { type: 'stopped', taskId: assigned.task.id, reason: 'No work remains in progress' } });
    assert.equal(hive.tasks.get(worker.agent, assigned.task.id).room!.status, 'stopped');
    const audit = await call(b, 'get_room', { channel: channel.id, history: true }); assert.equal(audit.history.length, 4);
  } finally {
    for (const c of clients) await c.close(); server.shutdown(); server.server.closeAllConnections(); hive.db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
