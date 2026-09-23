import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hive } from '../server/hive.ts';
import { startServer } from '../server/serve.ts';

test('real MCP brain requests a Human decision and Telegram-root reply resolves that exact request', { timeout: 20000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'decision-mcp-')), hive = new Hive(path.join(dir, 'hive.db'));
  const server = startServer({ hive, port: 0, telegram: false });
  const brain = hive.identity.join({ role: 'brain' }), worker = hive.identity.join({ role: 'worker', seniority: 'mid' });
  const reviewer = hive.identity.join({ role: 'worker', seniority: 'senior' });
  const channel = hive.channels.createChannel(brain.agent, { name: 'decision-mcp', type: 'private', memberNames: [worker.agent.name, reviewer.agent.name] });
  const task = hive.tasks.assign(brain.agent, { requestId: 'task', worker: worker.agent.name, channel: channel.id,
    contract: { objective: 'Choose parser policy', scope: ['parser'], nonGoals: [], acceptanceCriteria: ['Decision'], dependencies: [], evidenceSeqs: [] } }).task;
  const port = await server.ready, clients: Client[] = [], transports: StdioClientTransport[] = [];
  const env = (token: string) => ({ PATH: process.env.PATH ?? '', HIVEMIND_TOKEN: token,
    HIVEMIND_HOME: path.join(dir, 'identity'), HIVEMIND_URL: `http://127.0.0.1:${port}` });
  const args = ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'src/cli.ts')];
  const connect = async (token: string) => {
    const client = new Client({ name: 'decision-fixture', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [...args, 'mcp'], cwd: dir, env: env(token), stderr: 'pipe' });
    clients.push(client); transports.push(transport); await client.connect(transport, { signal: t.signal, timeout: 5000 }); return client;
  };
  const call = async (client: Client, name: string, arguments_: Record<string, unknown>) => {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: arguments_ }, CallToolResultSchema, { signal: t.signal, timeout: 5000 }));
    assert.notEqual(result.isError, true, JSON.stringify(result)); const item = result.content[0]; assert.ok(item?.type === 'text'); return JSON.parse(item.text);
  };
  try {
    const b = await connect(brain.token), w = await connect(worker.token);
    const input = { requestId: 'decision-one', taskId: task.id, expectedTaskRevision: 1,
      question: 'Strict or compatible?', options: [{ id: 'strict', label: 'Strict', impact: 'Break legacy' }, { id: 'compat', label: 'Compatible', impact: 'Preserve legacy' }],
      recommendation: { optionId: 'compat', rationale: 'Lower migration risk', uncertainty: 'Medium' },
      evidenceSeqs: [], artifacts: [], affectedWorkers: [worker.agent.name, reviewer.agent.name], relatedDecisionIds: [] };
    const made = await call(b, 'request_human_decision', input);
    assert.equal(made.decision.state, 'awaiting_input');
    const denied = await w.callTool({ name: 'request_human_decision', arguments: input }); assert.equal(denied.isError, true);
    const before = await call(b, 'get_task_decisions', { taskId: task.id }); assert.equal(before.decisions[0].id, made.decision.id);
    hive.messages.postMessage(hive.identity.getAgent('human'), { channel: channel.id, threadId: made.decision.id,
      body: 'Telegram answer: compatible.', source: 'telegram' });
    const answered = await call(b, 'get_decision', { decisionId: made.decision.id });
    assert.equal(answered.decision.state, 'answered'); assert.equal(answered.decision.answer.source, 'telegram');
    assert.equal(hive.tasks.get(brain.agent, task.id).revision, 1);
  } finally {
    for (const client of clients) await client.close();
    for (const transport of transports) await transport.close();
    await server.shutdown(); hive.db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
