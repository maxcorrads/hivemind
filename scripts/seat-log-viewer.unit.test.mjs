// Renderer contract for the read-only `--watch` seat viewer. Fixture events follow the shape of opencode
// `run --format json` output retained by earlier pilots (step_start, text, tool_use, step_finish, error).
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderEvent, renderLine, seatLogNames } from './seat-log-viewer.mjs';

const tool = (name, state) => ({ type: 'tool_use', part: { type: 'tool', tool: name, callID: 'call_1', state } });

test('assistant text, reasoning and step boundaries', () => {
  assert.equal(renderEvent({ type: 'step_start', part: { type: 'step-start' } }), null);
  assert.equal(renderEvent({ type: 'text', part: { type: 'text', text: 'Plan:\n  split the  modules' } }), 'say  Plan: split the modules');
  assert.equal(renderEvent({ type: 'reasoning', part: { text: 'thinking hard' } }), 'think thinking hard');
  assert.equal(renderEvent({ type: 'text', part: { text: '' } }), null);
  assert.ok(renderEvent({ type: 'text', part: { text: 'x'.repeat(2000) } }).length <= 606);
});

test('tool calls: shell, file writes/edits/reads, hivemind tools and failures', () => {
  assert.equal(renderEvent(tool('bash', { status: 'completed', input: { command: 'node --test test/*.test.mjs' }, metadata: { exit: 0 } })),
    '$ node --test test/*.test.mjs  (exit 0)');
  assert.equal(renderEvent(tool('write', { status: 'completed', input: { filePath: '/w/src/a.mjs', content: 'a\nb\nc' } })), 'write /w/src/a.mjs (3 lines)');
  assert.equal(renderEvent(tool('edit', { status: 'completed', input: { filePath: '/w/src/a.mjs', oldString: 'a', newString: 'a\nb' } })),
    'edit /w/src/a.mjs (-1 +2 lines)');
  assert.equal(renderEvent(tool('read', { status: 'completed', input: { filePath: '/w/README' } })), 'read /w/README');
  assert.equal(renderEvent(tool('hivemind_assign_task', { status: 'completed', input: { worker: 'Lathe', contract: { objective: 'parse' } } })),
    'hive assign_task worker="Lathe" contract={"objective":"parse"}');
  assert.equal(renderEvent(tool('glob', { status: 'completed', input: { pattern: '**/*.mjs' } })), 'tool glob pattern="**/*.mjs"');
  assert.equal(renderEvent(tool('hivemind_task_event', { status: 'error', input: { taskId: 't1' }, error: 'MCP error -32602: Invalid discriminator' })),
    'hive task_event taskId="t1"\n    ! MCP error -32602: Invalid discriminator');
});

test('token usage, errors and unknown events', () => {
  assert.equal(renderEvent({ type: 'step_finish', part: { tokens: { total: 18585, input: 18305, output: 102, cache: { read: 113 } } } }),
    'tokens 18585 cumulative (in 18305, out 102, cache 113)');
  assert.equal(renderEvent({ type: 'step_finish', part: {} }), null);
  assert.equal(renderEvent({ type: 'error', error: { name: 'APIError', data: { message: 'rate limited' } } }), 'ERROR rate limited');
  assert.equal(renderEvent({ type: 'session_idle' }), '(session_idle)');
  assert.equal(renderEvent(null), null);
});

test('raw lines: JSON on stdout, plain stderr, non-JSON noise and colour', () => {
  assert.equal(renderLine('{"type":"text","part":{"text":"hi"}}'), 'say  hi');
  assert.equal(renderLine('Error: database is locked', { stream: 'stderr' }), 'stderr| Error: database is locked');
  assert.equal(renderLine('{not json'), '{not json');
  assert.equal(renderLine('   '), null);
  assert.equal(renderLine('boom', { stream: 'stderr', color: true }), '\u001b[33mstderr| boom\u001b[0m');
});

test('retry logs are followed in launch order', () => {
  assert.deepEqual(seatLogNames('brain', 0), { stdout: 'brain.stdout.log', stderr: 'brain.stderr.log' });
  assert.deepEqual(seatLogNames('worker-2', 1), { stdout: 'worker-2.retry-1.stdout.log', stderr: 'worker-2.retry-1.stderr.log' });
});
