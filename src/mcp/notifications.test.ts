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
import { markInboxRead } from '../server/test-fixtures.ts';
import type { WaitResult } from '../shared/types.ts';

test('real MCP and CLI configure the same scoped subscriptions and deliver targeted events with explicit ACK', { timeout: 25_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-notification-clients-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const server = startServer({ port: 0, hive, telegram: false }); const port = await server.ready;
  const brain = hive.identity.join({ role: 'brain' }), worker = hive.identity.join({ role: 'worker', seniority: 'mid' });
  const general = hive.channels.getChannel('general', brain.agent.projectId);
  markInboxRead(hive);
  const clients: Client[] = [];
  const env = (token: string) => ({ PATH: process.env.PATH ?? '', HIVEMIND_TOKEN: token,
    HIVEMIND_HOME: path.join(dir, 'identities'), HIVEMIND_URL: `http://127.0.0.1:${port}` });
  const args = ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'src/cli.ts')];
  const connect = async (token: string) => {
    const client = new Client({ name: 'notification-fixture', version: '1' }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [...args, 'mcp'], cwd: dir, env: env(token), stderr: 'pipe' }));
    return client;
  };
  const call = async <T = any>(client: Client, name: string, input: Record<string, unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: input }); assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse((result.content as { type: string; text: string }[]).find(c => c.type === 'text')!.text);
  };
  const cli = async (token: string, input: string[]) => (await promisify(execFile)(process.execPath, [...args, ...input],
    { cwd: dir, env: env(token), timeout: 10_000 })).stdout;
  try {
    const reader = await connect(brain.token), writer = await connect(worker.token);
    await call(reader, 'set_subscription', { channel: general.id, eventTypes: ['blocker'] });
    const listed = JSON.parse(await cli(brain.token, ['subscriptions', 'list']));
    assert.deepEqual(listed, await call(reader, 'subscriptions'));
    await call(writer, 'send', { channel: general.id, body: 'Thanks', eventType: 'acknowledgement', recipients: [brain.agent.name] });
    await call(writer, 'send', { channel: general.id, body: 'Non-actionable update', eventType: 'progress' });
    const blocker = await call(writer, 'send', { channel: general.id, body: 'Input needed', eventType: 'blocker' });
    const first = await call<WaitResult>(reader, 'wait');
    assert.deepEqual(first.delivery!.messageSeqs, [blocker.seq]);
    assert.equal(hive.inbox.status(brain.agent.id).awaitingReceipt, 1);
    await call(reader, 'ack_delivery', { deliveryId: first.delivery!.id });
    await cli(brain.token, ['subscriptions', 'set', '--channel', general.id, '--mute']);
    assert.deepEqual((await call(reader, 'subscriptions')).subscriptions[0].eventTypes, []);
    const sent = await cli(worker.token, ['send', '--channel', general.id, '--recipients', brain.agent.name,
      '--event-type', 'decision', '--body', 'Explicit target despite mute']);
    const seq = Number(/seq (\d+)/.exec(sent)![1]);
    const direct = await call<WaitResult>(reader, 'wait');
    assert.deepEqual(direct.delivery!.messageSeqs, [seq]);
    assert.deepEqual(direct.mail![0].recipientIds, [brain.agent.id]);
    await call(reader, 'ack_delivery', { deliveryId: direct.delivery!.id });
    await call(reader, 'reset_subscription', { channel: general.id });
    assert.deepEqual((await call(reader, 'subscriptions')).subscriptions, []);
  } finally {
    for (const client of clients) await client.close();
    server.shutdown(); server.server.closeAllConnections(); hive.db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
