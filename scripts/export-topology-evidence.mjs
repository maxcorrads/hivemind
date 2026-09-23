import { closeSync, existsSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { exportAdaptiveEvidence } from '../src/server/adaptive-evidence.ts';
import { Storage } from '../src/server/storage.ts';

export function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--db', '--execution', '--output'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || options[key])
      throw new Error('Use --db <existing hive.db> --execution <id from Routing state> --output <new JSON file>');
    options[key] = argv[i + 1];
  }
  if (!options['--db'] || !options['--execution'] || !options['--output']) throw new Error('--db, --execution and --output are required');
  const file = path.resolve(options['--db']), output = path.resolve(options['--output']);
  if (!existsSync(file)) throw new Error('Database does not exist');
  if (existsSync(output)) throw new Error('Output already exists; choose a new path to retain previous evidence');
  const db = new DatabaseSync(file, { readOnly: true });
  let report;
  try {
    report = Storage.for(db).transaction(() => exportAdaptiveEvidence(db, options['--execution']), { immediate: false });
  } finally { db.close(); }
  const fd = openSync(output, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(report, null, 2) + '\n'); } finally { closeSync(fd); }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : 'Evidence export failed'); process.exitCode = 1;
  }
}
