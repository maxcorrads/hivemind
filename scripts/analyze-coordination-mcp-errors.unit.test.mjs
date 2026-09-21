import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { analyzeRecoverableErrors, classifyRecoverableError, readToolErrors } from './analyze-coordination-mcp-errors.mjs';

function line(tool, error, input = {}) {
  return JSON.stringify({
    part: {
      type: 'tool',
      tool,
      state: { status: 'error', input, error },
    },
  });
}

test('coordination MCP error classifier reproduces benchmark root-cause buckets', () => {
  assert.equal(classifyRecoverableError('hivemind_get_worker_capabilities',
    'MCP error -32602: Input validation error: Invalid UUID at workerId'), 'worker_reference');
  assert.equal(classifyRecoverableError('hivemind_get_room', 'Channel not found'), 'visibility_reference');
  assert.equal(classifyRecoverableError('hivemind_get_task', 'Cannot read this task'), 'visibility_reference');
  assert.equal(classifyRecoverableError('hivemind_assign_task', 'Cannot read this message'), 'visibility_reference');
  assert.equal(classifyRecoverableError('hivemind_room_event',
    'Room changed; get_room and reconcile the current revision'), 'room_state_reconciliation');
  assert.equal(classifyRecoverableError('hivemind_task_event',
    'Acknowledge the current room contract before continuing the task'), 'room_state_reconciliation');
  assert.equal(classifyRecoverableError('hivemind_assign_task',
    'MCP error -32602: Input validation error: Invalid arguments'), 'schema_invalid_argument');
});

test('coordination MCP analyzer scans OpenCode JSONL seat logs deterministically', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-mcp-errors-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const attempt = path.join(dir, 'runs', 'trial-fixture', 'attempt-001');
  mkdirSync(attempt, { recursive: true });
  writeFileSync(path.join(attempt, 'brain.stdout.txt'), [
    line('hivemind_assign_task', 'MCP error -32602: Input validation error: Invalid arguments for tool assign_task'),
    line('hivemind_get_room', 'Channel not found'),
    JSON.stringify({ part: { type: 'text', text: 'not an error' } }),
    '',
  ].join('\n'));
  writeFileSync(path.join(attempt, 'worker-1.stdout.txt'), [
    line('hivemind_get_worker_capabilities', 'MCP error -32602: Input validation error: Invalid UUID at workerId'),
    line('hivemind_room_event', 'Room changed; get_room and reconcile the current revision'),
    '',
  ].join('\n'));

  assert.equal(readToolErrors(path.join(attempt, 'brain.stdout.txt')).length, 2);
  const report = analyzeRecoverableErrors(dir);
  assert.equal(report.scannedSeatLogs, 2);
  assert.equal(report.totalRecoverableErrors, 4);
  assert.deepEqual(report.byCategory, {
    room_state_reconciliation: 1,
    schema_invalid_argument: 1,
    visibility_reference: 1,
    worker_reference: 1,
  });
  assert.deepEqual(report.byTool, {
    assign_task: 1,
    get_room: 1,
    get_worker_capabilities: 1,
    room_event: 1,
  });
  assert.equal(report.signatures.length, 4);
});
