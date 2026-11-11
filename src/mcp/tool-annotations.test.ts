import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hive } from '../server/hive.ts';
import { startServer } from '../server/serve.ts';
import { snapshotTables, tableNames } from '../server/test-fixtures.ts';
import { childEnv } from '../test-support/child-process.ts';
import { TOOL_ANNOTATIONS } from './tool-annotations.ts';

// A client may run a read-only call without asking the person, and several side by side, so the claim is checked
// against the real server: every tool declared read-only is called over stdio and the whole database compared.
test('a tool declared read-only leaves the hive as it was', { timeout: 30_000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-read-only-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const server = startServer({ hive, port: 0, telegram: false });
  const client = new Client({ name: 'read-only-fixture', version: '1' });
  let transport: StdioClientTransport | undefined;
  t.after(async () => {
    try { await client.close(); await transport?.close(); }
    finally { await server.shutdown(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  const port = await server.ready;

  // Something to read: a brain and a worker of one project, a task between them, and a message in its channel.
  const brain = hive.identity.join({ role: 'brain', project: 'acme' });
  const worker = hive.identity.join({ role: 'worker', seniority: 'mid', project: 'acme' });
  const task = hive.tasks.assign(brain.agent, { requestId: 'read-only-fixture', worker: worker.agent.name,
    contract: { objective: 'Read the fixture', scope: [], nonGoals: [], acceptanceCriteria: ['Read'], dependencies: [], evidenceSeqs: [] } }).task;
  const message = hive.messages.postMessage(brain.agent, { channel: task.channelId, body: 'Something to read' });

  transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'src/cli.ts'), 'mcp'],
    cwd: dir,
    env: childEnv({ PATH: process.env.PATH ?? '', HIVEMIND_HOME: path.join(dir, 'client'),
      HIVEMIND_URL: `http://127.0.0.1:${port}`, HIVEMIND_TOKEN: brain.token }),
    stderr: 'pipe' });
  await client.connect(transport, { timeout: 5000, signal: t.signal });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema,
      { timeout: 5000, signal: t.signal }));
    assert.notEqual(result.isError, true, `${name} ${JSON.stringify(args)}: ${JSON.stringify(result.content)}`);
  };

  // Every way each read-only tool reads, with arguments that reach the data above.
  const reads: Record<string, Array<Record<string, unknown>>> = {
    whoami: [{}, { orders: true }],
    agents: [{}],
    bot_tools: [{}],
    channels: [{}, { unread: true }],
    search: [{ q: 'read' }],
    history: [{ channel: task.channelId, meta: true }, { channel: task.channelId, threadId: task.id }],
    expand_digest: [{ channel: task.channelId, messageIds: [message.id] }],
    get_room: [{ channel: task.channelId }, { channel: task.channelId, history: true }],
    worker_templates: [{}],
    get_worker_capabilities: [{ workerId: worker.agent.id }, { workerId: worker.agent.name }],
    worker_match_suggest: [{ taskId: task.id, mode: 'implementation', category: 'general' }],
    get_handoffs: [{}, { taskId: task.id }],
    get_task: [{ taskId: task.id }],
    get_task_timeline: [{ taskId: task.id }, { taskId: task.id, export: true }],
    preview_task_claim: [{ taskId: task.id, paths: ['src/parser'] }],
  };
  const declared = Object.entries(TOOL_ANNOTATIONS).filter(([, hints]) => hints.readOnlyHint).map(([name]) => name);
  assert.deepEqual(Object.keys(reads).sort(), declared.sort(), 'every tool declared read-only is called here');

  const tables = tableNames(hive);
  assert.ok(tables.includes('agents') && tables.includes('messages'));
  // Every request records its caller's presence (last seen, online); a read-only call may change nothing else.
  const state = () => {
    const rows = snapshotTables(hive, tables);
    rows.agents = rows.agents!.map(({ last_seen_at: _seen, online: _online, ...agent }) => agent);
    return rows;
  };
  for (const [name, variants] of Object.entries(reads)) {
    for (const args of variants) {
      const before = state();
      await call(name, args);
      const after = state();
      for (const table of tables) assert.deepEqual(after[table], before[table], `${name} ${JSON.stringify(args)} changed ${table}`);
    }
  }

  const before = state();
  await call('send', { channel: task.channelId, body: 'A write' });
  assert.notDeepEqual(state(), before, 'the comparison sees a write');
});
