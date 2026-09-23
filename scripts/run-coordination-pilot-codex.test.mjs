import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadFixtures } from './benchmark-coordination.mjs';
import { Hive } from '../src/server/hive.ts';
import {
  REAL_AGENT_PROMPT_VERSION,
  REAL_AGENT_TASK_VERSION,
  coordinationPrivateFacts,
  expectedTaskOutputs,
  main as realMain,
  trialTemplate,
} from './benchmark-coordination-real.mjs';
import {
  BENCHMARK_PORT,
  bootstrapBenchmarkHumanSession,
  buildBrainPrompt,
  buildSinglePrompt,
  buildWorkerPrompt,
  codexArgs,
  humanRoomInstructionBody,
  codexExecutable,
  hostExecutable,
  hostInvocation,
  opencodeArgs,
  openCodeUsageAccumulator,
  parseProviderTokens,
  main as runnerMain,
  readCoordinationEvidence,
  reviewArtifact,
  seatPlan,
  seedHumanRoomInstruction,
  strictTrialFiles,
} from './run-coordination-pilot-codex.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = loadFixtures(root);
const byId = new Map(fixtures.map(fixture => [fixture.id, fixture]));
const config = {
  provider: 'openai',
  model: 'gpt-fixture',
  host: 'codex',
  configuration: 'reasoning=max',
  hivemindRevision: 'abc123',
  promptVersion: REAL_AGENT_PROMPT_VERSION,
  taskVersion: REAL_AGENT_TASK_VERSION,
};

test('real-agent v4 prompt carries executable deterministic work without leaking answers', () => {
  const fixture = byId.get('shared-interface-coupled');
  const trial = trialTemplate(fixture, 'brain_multi_dm', 29, 0, config);
  const expected = expectedTaskOutputs(fixture, 29, 0);
  assert.equal(REAL_AGENT_PROMPT_VERSION, 'coordination-real-v4');
  assert.match(trial.runbook.prompt, /Executable benchmark artifact contract/);
  assert.match(trial.runbook.prompt, /coordination-real-v4\|fixture=shared-interface-coupled/);
  assert.match(trial.runbook.prompt, /BENCHMARK_RESULT|final acceptance artifact/i);
  for (const output of Object.values(expected)) {
    assert.match(output, /^[a-f0-9]{64}$/);
    assert.ok(!trial.runbook.prompt.includes(output), 'answer hash must not be in participant prompt');
  }
});

test('noisy-room instructions are conditional on the room workflow', () => {
  const fixture = byId.get('noisy-room');
  const dm = trialTemplate(fixture, 'brain_multi_dm', 29, 0, config);
  const room = trialTemplate(fixture, 'brain_multi_room', 29, 0, config);
  assert.match(dm.runbook.prompt, /Room-only noise injection is not applicable/);
  assert.doesNotMatch(dm.runbook.prompt, /inject 12 unrelated room observations/);
  assert.match(room.runbook.prompt, /inject 12 unrelated room observations/);
});

test('Codex runner is generic: default executable is codex and local override is environment-only', () => {
  assert.equal(codexExecutable({}), 'codex');
  assert.equal(codexExecutable({ CODEX_BIN: '/opt/local/my-codex-wrapper' }), '/opt/local/my-codex-wrapper');
  const trial = trialTemplate(byId.get('independent-implementation'), 'single_worker', 29, 0, config);
  const args = codexArgs(trial);
  assert.deepEqual(args.slice(0, 4), ['exec', '--skip-git-repo-check', '--model', 'gpt-fixture']);
  assert.ok(args.includes('model_reasoning_effort="max"'));
  assert.ok(args.includes('agents.enabled=false'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('memories.use_memories=false'));
  assert.ok(args.includes('memories.generate_memories=false'));
  assert.ok(args.includes('workspace-write'));
});

test('OpenCode host uses requested model, --auto and runtime Hivemind MCP', () => {
  const fixture = byId.get('independent-implementation');
  const openConfig = {
    ...config,
    provider: 'opencode',
    model: 'opencode/muse-spark-1.3',
    host: 'opencode',
    configuration: 'auto',
  };
  const trial = trialTemplate(fixture, 'brain_multi_dm', 29, 0, openConfig);
  assert.equal(hostExecutable('opencode', {}), 'opencode');
  assert.equal(hostExecutable('opencode', { OPENCODE_BIN: '/opt/local/opencode-custom' }), '/opt/local/opencode-custom');
  const workdir = '/tmp/hive-opencode-trial-workspace';
  const args = opencodeArgs(trial, 'benchmark prompt', workdir);
  assert.deepEqual(args.slice(0, 5), ['--pure', 'run', '--dir', workdir, '--model']);
  assert.ok(args.includes('opencode/muse-spark-1.3'));
  assert.ok(args.includes('--auto'));
  assert.ok(!args.includes('--standalone'));
  assert.ok(args.includes('--format'));
  assert.equal(args.at(-1), 'benchmark prompt');

  const baseEnv = {
    PATH: '/usr/bin',
    HIVEMIND_URL: 'http://127.0.0.1:7420',
    HIVEMIND_HOME: '/tmp/hive-identities',
  };
  const invocation = hostInvocation(trial, 'benchmark prompt', baseEnv, root, true, workdir);
  assert.equal(invocation.stdin, null);
  assert.equal(invocation.args[invocation.args.indexOf('--dir') + 1], workdir);
  assert.equal(invocation.env.OPENCODE_DISABLE_AUTOUPDATE, 'true');
  const inline = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(inline.tools.task, false);
  assert.equal(inline.mcp.hivemind.type, 'local');
  assert.equal(inline.mcp.hivemind.enabled, true);
  assert.equal(inline.mcp.hivemind.environment.HIVEMIND_URL, baseEnv.HIVEMIND_URL);
  assert.equal(inline.mcp.hivemind.environment.HIVEMIND_HOME, baseEnv.HIVEMIND_HOME);
  assert.ok(inline.mcp.hivemind.command.some(value => value.endsWith('/src/cli.ts')));
});

test('single-worker OpenCode invocation does not expose the Hivemind MCP', () => {
  const fixture = byId.get('independent-implementation');
  const trial = trialTemplate(fixture, 'single_worker', 29, 0, {
    ...config,
    provider: 'opencode',
    model: 'opencode/muse-spark-1.3',
    host: 'opencode',
    configuration: 'auto',
  });
  const workdir = '/tmp/hive-opencode-single-workspace';
  const invocation = hostInvocation(trial, 'single prompt', { PATH: '/usr/bin' }, root, false, workdir);
  const inline = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(inline.tools.task, false);
  assert.equal(inline.mcp, undefined);
  assert.equal(invocation.args[invocation.args.indexOf('--dir') + 1], workdir);
});

test('runner seat plans preserve the four workflow shapes', () => {
  const fixture = byId.get('independent-implementation');
  const count = workflow => seatPlan(trialTemplate(fixture, workflow, 29, 0, config), fixture).length;
  assert.equal(count('single_worker'), 1);
  assert.equal(count('brain_one_worker'), 2);
  assert.equal(count('brain_multi_dm'), 4);
  assert.equal(count('brain_multi_room'), 4);
});

test('runner prompts keep native agents disabled while coordinating through Hivemind seats', () => {
  const fixture = byId.get('independent-implementation');
  const multi = trialTemplate(fixture, 'brain_multi_dm', 29, 0, config);
  const single = trialTemplate(fixture, 'single_worker', 29, 0, config);
  assert.match(buildSinglePrompt(single, fixture), /Do not use Hivemind, native subagents, or delegation/);
  const workerPrompt = buildWorkerPrompt(multi, fixture, fixture.workers[0], 1);
  assert.match(workerPrompt, /Join with role=worker/);
  assert.match(workerPrompt, /set_capabilities/);
  assert.match(workerPrompt, /BENCHMARK_STOP/);
  const brainPrompt = buildBrainPrompt(multi, fixture, 3);
  assert.match(brainPrompt, /Join with role=brain/);
  assert.match(brainPrompt, /task DMs only/);
  assert.match(brainPrompt, /Do not perform worker task outputs yourself/);
});

test('partitioned prompts expose all facts to single, one fact per worker, and none to the brain', () => {
  const fixture = byId.get('room-peer-clarification');
  const dm = trialTemplate(fixture, 'brain_multi_dm', 29, 0, config);
  const room = trialTemplate(fixture, 'brain_multi_room', 29, 0, config);
  const single = trialTemplate(fixture, 'single_worker', 29, 0, config);
  const facts = coordinationPrivateFacts(fixture, 29, 0);
  assert.equal(facts.length, 3);

  const singlePrompt = buildSinglePrompt(single, fixture);
  for (const fact of facts) assert.match(singlePrompt, new RegExp(fact.value));

  const brainPrompt = buildBrainPrompt(dm, fixture, 3);
  assert.match(brainPrompt, /information-partitioned/);
  assert.match(brainPrompt, /Relay explicit clarification questions/);
  for (const fact of facts) assert.ok(!brainPrompt.includes(fact.value));

  for (let index = 0; index < fixture.workers.length; index++) {
    const worker = fixture.workers[index];
    const prompt = buildWorkerPrompt(dm, fixture, worker, index + 1);
    const own = facts.find(fact => fact.workerId === worker.id);
    assert.match(prompt, new RegExp(own.value));
    for (const other of facts.filter(fact => fact.workerId !== worker.id)) assert.ok(!prompt.includes(other.value));
    assert.match(prompt, /eventType=question/);
    assert.match(prompt, /Ask the brain to relay/);
  }

  const roomWorker = buildWorkerPrompt(room, fixture, fixture.workers[0], 1);
  assert.match(roomWorker, /address the worker who owns the missing fact directly/);
  const roomBrain = buildBrainPrompt(room, fixture, 3, 42);
  assert.match(roomBrain, /ask addressed peer questions/);
  for (const fact of facts) assert.ok(!roomBrain.includes(fact.value));
});

test('coordination evidence counts worker questions without retaining message bodies', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-clarification-evidence-'));
  const file = path.join(dir, 'hive.db');
  const hive = new Hive(file);
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const brain = hive.identity.join({ role: 'brain' }).agent;
  const a = hive.identity.join({ role: 'worker', seniority: 'mid' }).agent;
  const b = hive.identity.join({ role: 'worker', seniority: 'mid' }).agent;
  const roomChannel = hive.channels.createChannel(brain, { name: 'clarification-evidence', type: 'private', memberNames: [a.name, b.name] });
  hive.messages.postMessage(a, { channel: roomChannel.id, body: 'Need the peer fact', recipients: [b.name], eventType: 'question' });
  const evidence = readCoordinationEvidence(file);
  assert.deepEqual(evidence, {
    questionMessages: 1,
    workerQuestions: 1,
    peerDirectedQuestions: 1,
    brainDirectedQuestions: 0,
    roomQuestions: 1,
    dmQuestions: 0,
  });
});

test('room workflow requires and embeds a real Human instruction sequence', () => {
  const fixture = byId.get('independent-implementation');
  const room = trialTemplate(fixture, 'brain_multi_room', 29, 0, config);
  assert.throws(() => buildBrainPrompt(room, fixture, 3), /requires a real Human instruction sequence/);
  const prompt = buildBrainPrompt(room, fixture, 3, 42);
  assert.match(prompt, /humanInstructionSeq=42/);
  assert.match(prompt, /originTaskId/);
  assert.match(prompt, /Do not ask Human for another authorization/);
  const authority = humanRoomInstructionBody(room);
  assert.match(authority, new RegExp(room.blindId));
  assert.match(authority, /finite task-scoped collaboration room/);
});

test('benchmark Human session bootstrap requires a returned local session cookie', async t => {
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    assert.match(String(url), /\/api\/ui\/session$/);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.origin, `http://127.0.0.1:${BENCHMARK_PORT}`);
    assert.equal(init.headers['content-type'], 'application/json');
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'hivemind_human_7420=session-value; HttpOnly; SameSite=Strict; Path=/',
      },
    });
  });
  const cookie = await bootstrapBenchmarkHumanSession(`http://127.0.0.1:${BENCHMARK_PORT}`);
  assert.equal(cookie, 'hivemind_human_7420=session-value');
});

test('room authority seeding bootstraps Human auth, writes a local Human message and returns its seq', async t => {
  const fixture = byId.get('independent-implementation');
  const room = trialTemplate(fixture, 'brain_multi_room', 29, 0, config);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/ui/session')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'hivemind_human_7420=session-value; HttpOnly; SameSite=Strict; Path=/',
        },
      });
    }
    if (String(url).endsWith('/api/ui/snapshot')) {
      return new Response(JSON.stringify({
        projects: [{ id: 'project-1', slug: 'chapter' }],
        channels: [{ id: 'general-1', name: 'general', projectId: 'project-1' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: { id: 'message-1', seq: 73 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const seeded = await seedHumanRoomInstruction(room);
  assert.equal(seeded.seq, 73);
  assert.equal(seeded.channelId, 'general-1');
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/api\/ui\/session$/);
  assert.match(calls[1].url, /\/api\/ui\/snapshot$/);
  assert.match(calls[2].url, /\/api\/ui\/channels\/general-1\/messages$/);
  for (const call of calls.slice(1)) {
    assert.equal(call.init.headers.cookie, 'hivemind_human_7420=session-value');
    assert.equal(call.init.headers.origin, `http://127.0.0.1:${BENCHMARK_PORT}`);
    assert.equal(call.init.headers['x-hivemind-ui'], '1');
  }
  const posted = JSON.parse(calls[2].init.body);
  assert.equal(posted.requestId, `benchmark-authority-${room.trialId}`);
  assert.match(posted.body, /Human authorizes the coordinating brain/);
});

test('OpenCode usage accumulator keeps the latest cumulative total across chunk boundaries', () => {
  const usage = openCodeUsageAccumulator();
  usage.push(Buffer.from('{"type":"step_finish","part":{"tokens":{"total":12}}}\n{"type":"step_'));
  usage.push(Buffer.from('finish","part":{"tokens":{"total":34}}}\n{"type":"text"'));
  usage.push(Buffer.from('}\n'));
  assert.equal(usage.finish(), 34);
});

test('token parsing uses explicit Codex usage or the latest cumulative OpenCode total', () => {
  assert.equal(parseProviderTokens('tokens used\n9024\n'), 9024);
  assert.equal(parseProviderTokens('x\ntokens used\n12.077\n'), 12077);
  assert.equal(parseProviderTokens('tokens used\n9,024\n'), 9024);
  const openCode = [
    JSON.stringify({ type: 'step_finish', part: { tokens: { total: 18949 } } }),
    JSON.stringify({ type: 'text', part: { text: 'progress' } }),
    JSON.stringify({ type: 'step_finish', part: { tokens: { total: 21261 } } }),
  ].join('\n');
  assert.equal(parseProviderTokens(openCode), 21261);
  assert.equal(parseProviderTokens('{bad json}\n{"type":"step_finish","part":{"tokens":{"total":-1}}}'), null);
  assert.equal(parseProviderTokens('no usage line'), null);
});

test('deterministic artifact review accepts exact outputs and reports mismatches', () => {
  const fixture = byId.get('shared-interface-coupled');
  const trial = trialTemplate(fixture, 'brain_one_worker', 29, 1, config);
  const good = {
    schemaVersion: 1,
    fixtureId: fixture.id,
    seed: 29,
    repeatIndex: 1,
    taskOutputs: expectedTaskOutputs(fixture, 29, 1),
  };
  assert.deepEqual(reviewArtifact(good, trial, fixture).acceptancePassed, true);
  const bad = structuredClone(good);
  bad.taskOutputs.contract = 'bad';
  const reviewed = reviewArtifact(bad, trial, fixture);
  assert.equal(reviewed.acceptancePassed, false);
  assert.ok(reviewed.defects >= 1);
});

test('strict trial discovery ignores runner metadata JSON', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-pilot-runner-files-'));
  try {
    writeFileSync(path.join(dir, 'trial-1111111111111111.json'), '{}');
    writeFileSync(path.join(dir, 'trial-2222222222222222.json'), '{}');
    writeFileSync(path.join(dir, 'run-trial-1111111111111111.json'), '{}');
    writeFileSync(path.join(dir, 'trial-1111111111111111.run-meta.json'), '{}');
    writeFileSync(path.join(dir, 'manifest.json'), '{}');
    assert.deepEqual(strictTrialFiles(dir), ['trial-1111111111111111.json', 'trial-2222222222222222.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('focused clarification dry-run plans exactly six trials', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-clarification-dry-run-'));
  try {
    const out = path.join(dir, 'clarification');
    realMain([
      'prepare', '--root', root, '--output', out, '--preset', 'clarification-v1',
      '--provider', 'openai', '--model', 'fixture-model', '--host', 'codex',
      '--configuration', 'reasoning=max', '--hivemind-revision', 'dryrunsha',
    ]);
    const planned = await runnerMain(['--input', out, '--repo-root', root, '--dry-run']);
    assert.equal(planned.length, 6);
    assert.deepEqual(new Set(planned.map(row => row.workflow)),
      new Set(['single_worker', 'brain_multi_dm', 'brain_multi_room']));
    assert.ok(planned.every(row => row.fixtureId === 'room-peer-clarification' && row.dryRun === true));
    assert.ok(!readdirSync(out).some(name => name.startsWith('run-')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pilot dry-run plans all 24 trials without creating run metadata', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-pilot-dry-run-'));
  try {
    const out = path.join(dir, 'pilot');
    realMain([
      'prepare', '--root', root, '--output', out, '--preset', 'pilot-v1',
      '--provider', 'openai', '--model', 'fixture-model', '--host', 'codex',
      '--configuration', 'reasoning=max', '--hivemind-revision', 'dryrunsha',
    ]);
    const before = new Set(readdirSync(out));
    const planned = await runnerMain(['--input', out, '--repo-root', root, '--dry-run']);
    assert.equal(planned.length, 24);
    assert.ok(planned.every(row => row.dryRun === true));
    assert.deepEqual(new Set(readdirSync(out)), before);
    assert.ok(!readdirSync(out).some(name => name.startsWith('run-')));
    assert.ok(!existsSync(path.join(out, 'runs')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
