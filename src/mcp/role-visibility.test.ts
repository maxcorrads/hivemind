import assert from 'node:assert/strict';
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
import { configuredToolRole } from './index.ts';
import { leanSchema } from './lean-schema.ts';

const BRAIN_ONLY = [
  'bot_tools', 'call_bot_tool',
  'assign_task', 'job_event', 'worker_templates', 'request_worker', 'release_worker',
  'worker_match_suggest', 'worker_match_outcome', 'worker_match_override',
  'preview_task_claim', 'create_channel', 'invite', 'clear_context',
].sort();

const names = async (client: Client) => (await client.listTools()).tools.map(tool => tool.name).sort();
const without = (all: string[], visible: string[]) => all.filter(name => !visible.includes(name));
/** UTF-8 bytes of a value as tools/list carries it. */
const bytes = (value: unknown) => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));

/**
 * The most tools/list may weigh for each role, in bytes (docs/agent-connection.md, "Size of the tool list"): every
 * agent carries it in its context. About 3% above the size when it was set (38 215, 36 910 and 26 095), so a new tool
 * or a longer definition raises it on purpose, not unnoticed.
 */
const BUDGET = { 'no role': 39_500, brain: 38_000, worker: 27_000 } as const;

test('role hint is exact and a preloaded credential falls back to all tools', () => {
  assert.equal(configuredToolRole({}), null);
  assert.equal(configuredToolRole({ HIVEMIND_ROLE: 'brain' }), 'brain');
  assert.equal(configuredToolRole({ HIVEMIND_ROLE: 'worker', HIVEMIND_TOKEN: '' }), 'worker');
  for (const role of ['Brain', 'human', '', 'worker ']) assert.equal(configuredToolRole({ HIVEMIND_ROLE: role }), null);
  assert.equal(configuredToolRole({ HIVEMIND_ROLE: 'brain', HIVEMIND_TOKEN: 'credential' }), null);
});

test('real SDK tools/list is static per role; unknown credentials keep server authorization', { timeout: 30_000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-role-tools-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const service = startServer({ hive, port: 0, telegram: false });
  t.after(async () => { await service.shutdown(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${await service.ready}`;

  async function open(role?: string, token = '') {
    const client = new Client({ name: 'role-tools-fixture', version: '0' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'src/cli.ts'), 'mcp'],
      cwd: dir,
      env: childEnv({ PATH: process.env.PATH ?? '', HIVEMIND_HOME: path.join(dir, 'client'),
        HIVEMIND_URL: url, HIVEMIND_TOKEN: token, ...(role === undefined ? {} : { HIVEMIND_ROLE: role }) }),
      stderr: 'pipe' });
    await client.connect(transport, { timeout: 5000, signal: t.signal });
    t.after(async () => { await client.close(); await transport.close(); });
    return client;
  }

  const fallback = await open();
  const full = await names(fallback);
  assert.ok(BRAIN_ONLY.every(name => full.includes(name)));
  assert.ok(['join', 'room_event', 'task_event', 'get_worker_capabilities', 'set_capabilities']
    .every(name => full.includes(name)));

  const brain = await open('brain');
  const brainVisible = await names(brain);
  assert.deepEqual(without(full, brainVisible), ['set_capabilities']);
  assert.deepEqual(without(brainVisible, full), []);
  const hiddenWorkerTool = await brain.callTool({ name: 'set_capabilities', arguments: {} });
  assert.equal(hiddenWorkerTool.isError, true);
  assert.match(JSON.stringify(hiddenWorkerTool.content), /disabled/);

  const worker = await open('worker');
  const workerVisible = await names(worker);
  assert.deepEqual(without(full, workerVisible), BRAIN_ONLY);
  assert.deepEqual(without(workerVisible, full), []);
  assert.ok(['join', 'room_event', 'task_event', 'get_worker_capabilities', 'set_capabilities']
    .every(name => workerVisible.includes(name)));
  const hiddenBrainTool = await worker.callTool({ name: 'worker_templates', arguments: {} });
  assert.equal(hiddenBrainTool.isError, true);
  assert.match(JSON.stringify(hiddenBrainTool.content), /disabled/);

  // What tools/list costs each role: every agent carries it in its context. Its schemas are sent lean, within a budget.
  for (const [role, client] of [['no role', fallback], ['brain', brain], ['worker', worker]] as const) {
    const { tools } = await client.listTools();
    const sum = (part: 'description' | 'inputSchema') => tools.reduce((total, tool) => total + bytes(tool[part]), 0);
    const size = bytes(tools);
    t.diagnostic(`tools/list size, ${role}: ${size} bytes in ${tools.length} tools (descriptions ${sum('description')}, schemas ${sum('inputSchema')})`);
    assert.ok(size <= BUDGET[role],
      `tools/list for ${role} is ${size} bytes, over its budget of ${BUDGET[role]}: shorten a definition, or raise the budget on purpose`);
    for (const tool of tools) {
      assert.deepEqual(leanSchema(tool.inputSchema), tool.inputSchema, `${tool.name} is sent without $schema or a pattern next to a format`);
    }
    // A UUID keeps its format, which says what its regex said.
    assert.deepEqual(tools.find(tool => tool.name === 'ack_delivery')!.inputSchema,
      { type: 'object', properties: { deliveryId: { type: 'string', format: 'uuid' } }, required: ['deliveryId'] });
  }

  const prior = hive.identity.listAgents().length;
  const mismatch = await worker.callTool({ name: 'join', arguments: { role: 'brain' } });
  assert.equal(mismatch.isError, true);
  assert.match(JSON.stringify(mismatch.content), /configured for worker/);
  assert.equal(hive.identity.listAgents().length, prior, 'a mismatched join was rejected before HTTP');
  const joined = await worker.callTool({ name: 'join', arguments: { role: 'worker', seniority: 'mid' } });
  assert.notEqual(joined.isError, true, JSON.stringify(joined));
  assert.deepEqual(await names(worker), workerVisible, 'joining never mutates the tool list');

  const invalid = await open('human');
  assert.deepEqual(await names(invalid), full);
  const preloaded = await open('brain', hive.identity.join({ role: 'worker', seniority: 'mid' }).token);
  assert.deepEqual(await names(preloaded), full, 'the role hint cannot be trusted with a preloaded token');
  const preloadedJoin = await preloaded.callTool({ name: 'join', arguments: { role: 'worker' } });
  assert.notEqual(preloadedJoin.isError, true, 'the authenticated worker may join despite an unverified brain hint');
  const forbidden = await preloaded.callTool({ name: 'worker_templates', arguments: {} });
  assert.equal(forbidden.isError, true);
  assert.match(JSON.stringify(forbidden.content), /403|Only a project brain/);
});
