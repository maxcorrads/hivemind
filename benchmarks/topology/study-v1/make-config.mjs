// Writes the #132 study config for study-v1: parameters.json + exact workload digests + the pinned checkout revision.
// Credential-free and offline. Usage: node benchmarks/topology/study-v1/make-config.mjs [--output <new file>]
// The revision is this checkout's HEAD, which must be clean (the runner refuses any other checkout at run time).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha256 = file => createHash('sha256').update(readFileSync(path.join(here, file))).digest('hex');
const git = args => spawnSync('git', args, { cwd: here, encoding: 'utf8' });

const params = JSON.parse(readFileSync(path.join(here, 'parameters.json'), 'utf8'));
const plan = JSON.parse(readFileSync(path.join(here, 'plan.json'), 'utf8'));
const head = git(['rev-parse', 'HEAD']), status = git(['status', '--porcelain', '--untracked-files=no']);
assert.equal(head.status, 0, 'Not a git checkout');
assert.equal(status.stdout.trim(), '', 'Commit the study files first: the checkout must be clean at the pinned revision');
assert.equal(plan.host.name + '/' + plan.host.binaryVersion, params.versions.host, 'plan.host and parameters.versions.host disagree');

const byId = new Map(plan.workloads.map(w => [w.id, w]));
const config = {
  evidenceKind: params.evidenceKind,
  versions: { hivemindRevision: head.stdout.trim(), ...params.versions },
  workloads: params.workloads.map(({ id, version }) => {
    const entry = byId.get(id);
    assert.ok(entry, `plan.json is missing workload ${id}`);
    return { id, version, inputDigest: sha256(entry.input), acceptanceDigest: sha256(entry.acceptance) };
  }),
  repeats: params.repeats, seed: params.seed, freeWorkers: params.freeWorkers, limits: { ...params.limits },
};
assert.equal(config.workloads.length, plan.workloads.length, 'plan.json lists a workload that parameters.json does not');

const flag = process.argv.indexOf('--output');
const output = path.resolve(flag > 0 ? process.argv[flag + 1] : path.join(here, 'config.json'));
writeFileSync(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, hivemindRevision: config.versions.hivemindRevision, workloads: config.workloads.length }));
