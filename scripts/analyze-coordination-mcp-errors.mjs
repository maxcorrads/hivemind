import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else if (stat.isFile() && /(?:brain|worker-\d+|single)\.stdout\.txt$/.test(entry)) files.push(full);
  }
  return files;
}

export function classifyRecoverableError(toolName, error) {
  const tool = String(toolName ?? '').replace(/^hivemind_/, '');
  const message = String(error ?? '');
  if (tool === 'get_worker_capabilities' && /Invalid UUID at workerId/.test(message)) return 'worker_reference';
  if (/Channel not found|Cannot read this task|Cannot read this message/.test(message)) return 'visibility_reference';
  if (/Room changed; get_room|Acknowledge the current room contract|No room contract in this channel/.test(message)) return 'room_state_reconciliation';
  if (/Input validation error/.test(message)) return 'schema_invalid_argument';
  return 'other';
}

export function readToolErrors(file) {
  const errors = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const part = event?.part;
    if (part?.type !== 'tool' || part?.state?.status !== 'error') continue;
    errors.push({
      tool: String(part.tool ?? '').replace(/^hivemind_/, ''),
      error: String(part.state.error ?? ''),
      input: part.state.input ?? null,
      file,
    });
  }
  return errors;
}

export function analyzeRecoverableErrors(input) {
  const runs = path.join(input, 'runs');
  const files = walk(runs);
  const errors = files.flatMap(readToolErrors);
  const byCategory = {}, byTool = {}, signatures = {};
  for (const item of errors) {
    const category = classifyRecoverableError(item.tool, item.error);
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    byTool[item.tool] = (byTool[item.tool] ?? 0) + 1;
    const signature = `${item.tool}: ${item.error}`;
    signatures[signature] = (signatures[signature] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    input: path.resolve(input),
    scannedSeatLogs: files.length,
    totalRecoverableErrors: errors.length,
    byCategory: Object.fromEntries(Object.entries(byCategory).sort()),
    byTool: Object.fromEntries(Object.entries(byTool).sort()),
    signatures: Object.entries(signatures)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([signature, count]) => ({ count, signature })),
  };
}

function parseArgs(argv) {
  let input = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') input = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  assert.ok(input, 'Use --input <coordination cohort directory>');
  return path.resolve(input);
}

export function main(argv = process.argv.slice(2)) {
  const input = parseArgs(argv);
  const report = analyzeRecoverableErrors(input);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
