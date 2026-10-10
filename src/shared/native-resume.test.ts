import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { childEnv } from '../test-support/child-process.ts';
import { buildLaunchCommand, buildLaunchPrompt, launchBlockText } from './launch-prompt.ts';
import { nativeSessionSchema } from './native-session.ts';

const id = '67d735d1-9e33-4a61-9645-a931afc97f2b';
const base = { software: 'codex', workspacePath: '/tmp/example', cdWorktree: true, projectSlug: 'example',
  passProject: true, role: 'worker' as const, seniority: 'senior' as const, adoptUntrusted: true,
  resume: true, resumeName: 'Forge' };

test('native resume passes the exact ID as an argv item, separately from the Hivemind identity and prompt', () => {
  for (const software of ['codex', 'claude'] as const) {
    const { command, cwd } = buildLaunchCommand({ ...base, software, model: 'fixture-model', effort: 'high',
      nativeResume: { software, sessionId: id },
      hivemindMcp: { command: 'node', args: ['hivemind', 'mcp'], env: {} } });
    // Only a shell stub runs: no actual provider, model calls, sessions or user files.
    const result = spawnSync('bash', ['-c', `${software}() { printf '%s\\0' "$@"; }; ${command}`], { env: childEnv(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const args = result.stdout.split('\0').filter(Boolean);
    assert.deepEqual(args.slice(0, 2), [software === 'codex' ? 'resume' : '--resume', id]);
    assert.ok(args.includes('fixture-model'));
    assert.equal(cwd, '/tmp/example');
    assert.match(args.at(-1)!, /resume=Forge/);
    assert.match(args.at(-1)!, /nativeSession=.*67d735d1/);
    assert.match(args.at(-1)!, /get_handoffs/);
    assert.match(args.at(-1)!, /do not replay completed actions/);
    if (software === 'claude') assert.equal(args.at(-2), '--');
  }
});

test('native resume fails closed for missing IDs, foreign hosts, claims and ambiguous selectors', () => {
  for (const sessionId of ['', 'Forge', '--last', '../../session.jsonl', 'bad\nvalue'])
    assert.throws(() => buildLaunchCommand({ ...base, nativeResume: { software: 'codex', sessionId } }), /UUID/);
  assert.throws(() => buildLaunchCommand({ ...base, software: 'claude', nativeResume: { software: 'codex', sessionId: id } }), /same CLI/);
  assert.throws(() => buildLaunchCommand({ ...base, resume: false, nativeResume: { software: 'codex', sessionId: id } }), /existing Hivemind/);
  assert.throws(() => buildLaunchCommand({ ...base, claim: `hmc_${'0'.repeat(48)}`, nativeResume: { software: 'codex', sessionId: id } }), /existing Hivemind/);
  for (const extraFlags of ['--last', '--resume other', '--session-id=other', 'resume', '-r other', '--continue'])
    assert.throws(() => buildLaunchCommand({ ...base, extraFlags, nativeResume: { software: 'codex', sessionId: id } }), /conflicting/);
  assert.throws(() => buildLaunchCommand({ ...base, software: 'claude', extraFlags: '-c' }), /conflicting/);
  assert.throws(() => buildLaunchCommand({ ...base, software: 'claude', extraFlags: `-r${id}` }), /conflicting/);
  assert.doesNotThrow(() => buildLaunchCommand({ ...base, extraFlags: '-c foo=bar', nativeResume: { software: 'codex', sessionId: id } }));
  const padded = buildLaunchCommand({ ...base, nativeResume: { software: 'codex', sessionId: ` ${id} ` } });
  assert.match(padded.command, new RegExp(`"sessionId":"${id}"`));
});

test('identity-only recovery is explicitly new context and reporting never asks to scan conversations', () => {
  const { command } = buildLaunchCommand(base);
  assert.doesNotMatch(command, /codex resume /);
  assert.match(command, /new host conversation recovering Hivemind context/);
  assert.match(command, /old conversation instructions and checkpoints do not override current stops/);
  assert.doesNotMatch(command, /CODEX_THREAD_ID/);
  assert.doesNotMatch(buildLaunchPrompt({ ...base, software: 'claude' }), /CLAUDE_CODE_SESSION_ID/);
  assert.match(command, /Never guess an ID or inspect other conversations/);
  assert.equal(nativeSessionSchema.safeParse({ software: 'codex', sessionId: id, model: '', effort: '', token: 'secret' }).success, false);
});

test('tracked Codex uses a SessionStart callback and per-process MCP ticket, without asking the model for IDs', () => {
  const ticket = `hml_${'a'.repeat(64)}`;
  const built = buildLaunchCommand({ ...base, resume: false, software: 'codex-work',
    tracking: { ticket, sessionId: null },
    hivemindMcp: { command: 'node', args: ['cli.js', 'mcp'], env: { HIVEMIND_URL: 'http://127.0.0.1:7420' } } });
  const result = spawnSync('bash', ['-c', `codex-work() { printf '%s\\0' "$@"; }; ${built.command}`], { env: childEnv(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const args = result.stdout.split('\0').filter(Boolean);
  assert.ok(args.includes(`mcp_servers.hivemind.args=["cli.js","mcp","--launch-ticket","${ticket}"]`));
  const hook = args.find(arg => arg.startsWith('hooks.SessionStart='))!;
  assert.match(hook, /\^\(startup\|resume\)\$/);
  assert.match(hook, /_capture-session/);
  assert.doesNotMatch(built.command, /dangerously-bypass|skip.*trust|Include nativeSession=/);
  assert.match(args.at(-1)!, /records this launch configuration and native conversation automatically/);
  assert.match(args.at(-1)!, /requireLaunchTracking=true/);
});

for (const shell of ['bash', 'zsh']) test(`Cursor captures one exact chat and keeps the profile for creation and resume (${shell})`, () => {
  const ticket = `hml_${'a'.repeat(64)}`;
  const input = { ...base, software: 'cursor-work', resume: false, model: 'test-cursor-model', extraFlags: '--workspace /fixture/work',
    tracking: { ticket, sessionId: null },
    hivemindMcp: { command: 'node', args: ['cli.js', 'mcp'], env: { HIVEMIND_URL: 'http://127.0.0.1:7420' } } };
  const command = launchBlockText(buildLaunchCommand({ ...input, cdWorktree: false }), { CURSOR_CONFIG_DIR: '/fixture/profile with space' });
  const stub = `cursor-work() {
    printf '%s\\n' "$CURSOR_CONFIG_DIR" >&2
    if [ "$1" = '--model' ]; then
      [ "$2" = 'test-cursor-model' ] && [ "$3" = '--workspace' ] && [ "$4" = '/fixture/work' ] && [ "$5" = 'create-chat' ] || return 1
      printf '%s\\n' 'chat_fixture-42'
    else printf '%s\\0' "$@"; fi
  }
  node() { IFS= read -r chat || true; [ "$chat" = 'chat_fixture-42' ]; }
  `;
  const result = spawnSync(shell, ['-c', stub + command], { env: childEnv(), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stderr.trim().split('\n'), ['/fixture/profile with space', '/fixture/profile with space']);
  assert.deepEqual(result.stdout.split('\0').slice(0, 2), ['--resume', 'chat_fixture-42']);
  assert.match(result.stdout, /requireLaunchTracking=true/);
  assert.doesNotMatch(command, /--approve-mcps|mcp enable|--force|--yolo/);
  const failed = spawnSync(shell, ['-c', stub + '\nnode() { return 1; }\n' + command], { env: childEnv(), encoding: 'utf8' });
  assert.ifError(failed.error);
  assert.notEqual(failed.status, 0);
  assert.equal(failed.stdout, '', 'capture failure must never start an untracked conversation');
  const resume = buildLaunchCommand({ ...input, resume: true, nativeResume: { software: 'cursor', sessionId: 'chat_fixture-42' } });
  assert.doesNotMatch(resume.command, /create-chat/);
  assert.match(resume.command, /cursor-work --resume 'chat_fixture-42'/);
});
