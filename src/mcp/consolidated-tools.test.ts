import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hive } from '../server/hive.ts';
import { startServer } from '../server/serve.ts';
import { countRows } from '../server/test-fixtures.ts';
import { childEnv } from '../test-support/child-process.ts';

// Real stdio MCP against a real server: merged tools, #name references and the attach denylist (#218).
test('real MCP: merged timeline, #name on invite/attach, legacy executionId and the attach denylist', { timeout: 20_000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcp-merged-'))), hive = new Hive(path.join(dir, 'hive.db'));
  const server = startServer({ hive, port: 0, telegram: false });
  const home = path.join(dir, 'home'), work = path.join(dir, 'work');
  mkdirSync(path.join(home, '.ssh'), { recursive: true }); mkdirSync(work);
  const client = new Client({ name: 'merged-fixture', version: '1' });
  let transport: StdioClientTransport | undefined;
  try {
    const port = await server.ready;
    const brain = hive.identity.join({ role: 'brain' }), worker = hive.identity.join({ role: 'worker', seniority: 'mid' });
    const room = hive.channels.createChannel(brain.agent, { name: 'merged-room', type: 'private' });
    transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'src/cli.ts'), 'mcp'], cwd: work,
      env: childEnv({ PATH: process.env.PATH ?? '', HOME: home, HIVEMIND_HOME: path.join(dir, 'client'),
        HIVEMIND_URL: `http://127.0.0.1:${port}`, HIVEMIND_TOKEN: brain.token }), stderr: 'pipe' });
    await client.connect(transport, { signal: t.signal, timeout: 5000 });
    const raw = async (name: string, args: Record<string, unknown>) =>
      CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, { signal: t.signal, timeout: 5000 }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await raw(name, args); assert.notEqual(result.isError, true, JSON.stringify(result));
      const item = result.content[0]; assert.ok(item?.type === 'text'); return JSON.parse(item.text);
    };
    const refused = async (args: Record<string, unknown>, pattern: RegExp) => {
      const result = await raw('attach', { channel: '#merged-room', ...args });
      assert.equal(result.isError, true, JSON.stringify(result)); assert.match(JSON.stringify(result.content), pattern);
    };

    await call('invite', { channel: '#merged-room', members: [worker.agent.name] });
    assert.ok(hive.channels.getChannel(room.id).memberIds.includes(worker.agent.id));

    const report = path.join(work, 'report.txt'); writeFileSync(report, 'findings');
    const posted = await call('attach', { channel: '#merged-room', path: report, body: 'report' });
    assert.equal(hive.messageQueries.getMessageById(posted.id).channelId, room.id);
    const messagesBefore = countRows(hive, 'messages', { channel_id: room.id });

    writeFileSync(path.join(home, '.ssh', 'config'), 'Host *');
    writeFileSync(path.join(work, '.env'), 'TOKEN=secret');
    symlinkSync(path.join(home, '.ssh', 'config'), path.join(work, 'notes.txt'));
    symlinkSync(path.join(home, '.ssh'), path.join(work, 'keys'));
    await refused({ path: path.join(home, '.ssh', 'config') }, /attach refused .*inside ~\/\.ssh/);
    await refused({ path: '.env' }, /attach refused .*looks like a secret/);
    await refused({ path: 'notes.txt' }, /attach refused .*inside ~\/\.ssh/);
    await refused({ path: path.join('keys', 'config') }, /attach refused .*inside ~\/\.ssh/);
    mkdirSync(path.join(dir, 'client'), { recursive: true }); writeFileSync(path.join(dir, 'client', 'journal.db'), 'state');
    await refused({ path: path.join(dir, 'client', 'journal.db') }, /attach refused .*Hivemind data directory/);
    await refused({ path: 'missing.txt' }, /File not found/);
    assert.equal(countRows(hive, 'messages', { channel_id: room.id }), messagesBefore, 'nothing was posted');

    // Older clients may still pass executionId: the tool schema no longer has it and the call still succeeds.
    const legacy = await call('send', { channel: '#merged-room', body: 'legacy', executionId: 'execution-old' });
    assert.equal(hive.messageQueries.getMessageById(legacy.id).channelId, room.id);

    const task = hive.tasks.assign(brain.agent, { requestId: 'merged-task', worker: worker.agent.name, channel: room.id,
      contract: { objective: 'Timeline', scope: [], nonGoals: [], acceptanceCriteria: ['Done'], evidenceSeqs: [], dependencies: [] } }).task;
    const timeline = await call('get_task_timeline', { taskId: task.id });
    assert.ok(Array.isArray(timeline.timeline.events));
    const exported = await call('get_task_timeline', { taskId: task.id, export: true });
    assert.equal(exported.fixture.mode, 'fake-only');
  } finally {
    try { await client.close(); await transport?.close(); }
    finally { await server.shutdown(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});
