# Reproducible storage query comparison (fixture version 1)

This is a synthetic, local infrastructure measurement for #20/#6, not evidence
that more model agents improve coding quality, cost or completion time (#29).
The existing production scoping implementation was merged in #64; this change
publishes its reproducible acceptance evidence rather than rewriting it.

## Exact comparison

Before: `977c571a8749468e64ad7e52e7796d4c0f481fb1` (parent of #64).
After: `2f4477d649662ccc3a502c9916fa178053a35bf8` (#64 merge).
Both snapshots ran on the same exact Node **22.13.0**, SQLite 3.47.2, Linux x64
runtime and installed dependency cohort. Complete source hashes, CPU metadata,
all raw samples, response sizes, query counts and event-loop measurements are in
[`../benchmarks/results/storage-scoping-v1.json`](../benchmarks/results/storage-scoping-v1.json).
No provider, real credentials or existing hive was used.

Read operations use two discarded warmups then 12 samples; logical drains have
12 samples and include acknowledgement only when advertised by the source.
Fixtures independently vary active reader count, unrelated agents, projects,
channels, backlog, local backlog and body size. Each drain asserts exact FIFO
message IDs, no duplicates and no cross-project messages. Fixture insertion and
cleanup are excluded from timing. Before runs precede after runs; this is not a
randomized trial and p95 is descriptive (with 12 samples it is the maximum), not a
confidence interval. Small/sub-millisecond timing differences are noisy: the
local-backlog roster became slower despite fewer SQL calls. Do not extrapolate a
universal speedup from these data.

## Measured results

Times are milliseconds, p50 / p95. SQL counts are per roster call.

| Fixture | Roster statement executions before → after | Roster ms before → after | Full logical drain ms before → after |
|---|---:|---:|---:|
| baseline | 4 → 1 | 0.076 / 0.250 → 0.080 / 0.269 | 4.809 / 8.449 → 1.143 / 2.336 |
| active-agents-4 | 7 → 1 | 0.100 / 0.166 → 0.068 / 0.099 | 12.051 / 15.673 → 4.215 / 5.086 |
| foreign-agents-50000 | 50003 → 1 | 751.099 / 810.662 → 0.055 / 0.117 | 2.732 / 3.076 → 0.996 / 1.154 |
| foreign-projects-8 | 4 → 1 | 0.056 / 0.091 → 0.052 / 0.094 | 3.235 / 3.756 → 1.061 / 1.090 |
| foreign-channels-2000 | 4 → 1 | 0.058 / 0.083 → 0.051 / 0.095 | 88.891 / 92.313 → 1.028 / 1.128 |
| foreign-backlog-10000 | 4 → 1 | 0.057 / 0.088 → 0.057 / 0.134 | 3.342 / 5.499 → 1.560 / 1.870 |
| local-backlog-1200 | 4 → 1 | 0.054 / 0.123 → 0.167 / 1.489 | 83.438 / 102.832 → 11.165 / 12.254 |
| body-bytes-1 | 4 → 1 | 0.064 / 0.168 → 0.065 / 0.254 | 2.774 / 4.665 → 1.146 / 1.467 |
| body-bytes-4000 | 4 → 1 | 0.102 / 0.422 → 0.060 / 0.143 | 3.842 / 4.582 → 1.575 / 2.033 |

The controlled 50,000-unrelated-agent case performs **50,003 → 1** roster
statement executions. The 2,000-unrelated-channel case performs **4,011 → 2**
channel-query executions, while the default history page performs **48 → 9**.
These are the counts from this checked-in fixture and exact commit pair. Earlier
ad-hoc counts without retained inputs are not substituted for these measurements.

The default in-process Human HTTP snapshot is 4.238 / 6.640 ms before versus
1.647 / 2.202 ms after (294 → 31 statement executions). This global operation is
not expected to ignore all other projects. The harness intentionally omits it in
the 50k-agent and 2k-channel cases above a 100-foreign-agent/channel admission cap;
those cases contain an explicit `omitted` reason, not zero timings.

## What the counters mean

`statementExecutions` wraps `get`, `all` and `run` on prepared statements.
`returnedRows` counts rows returned to JavaScript, not database rows examined.
Statements run by triggers or `db.exec` are not inferred or included. The minimum
runtime does not expose the SQLite VM scan counters through this wrapper:
`rowsExamined` stays **null**, not zero. `EXPLAIN QUERY PLAN` regression assertions
in `src/server/query-contracts.test.ts` separately check indexed lookup/scoping.

Event-loop delay is measured at 10 ms resolution across each scenario, including
the yields between operations. RSS/heap are process snapshots, not per-request
peaks; several scenarios share one process, so GC history affects them. Wait
latency here is in-process, not an end-to-end TCP/provider measurement. The
separate `npm run benchmark:inbox -- 4 1200` exercises real local HTTP on the
current implementation and asserts byte/scan bounds and receipt-safe delivery.

## Current receipt-aware HTTP probe

After #91/#92, a separate absolute local HTTP run on product tree
`fa8b06ff8a6c935b5b1b8d5541c449a40083bf14` delivered 4 × 1,200 messages of
4,000 characters with exact sequence assertions and explicit receipts. It used
372 responses over 8,103.12 ms; p50 / p95 / p99 wait latency was
56.03 / 67.18 / 75.91 ms. Maximum HTTP bytes were 57,779, encoded wire bytes
61,048, scanned rows 256 and hydrated messages 14. Raw results are in
[`inbox-current-v1.json`](../benchmarks/results/inbox-current-v1.json).
This is a single synthetic container run, not a throughput guarantee, an agent
capacity limit, or a before/after comparison to a different receipt protocol.

## Reproduce

Install the locked dependencies and use Node 22.13.0. Create two local worktrees:

```sh
git worktree add --detach ../hive-before 977c571a8749468e64ad7e52e7796d4c0f481fb1
git worktree add --detach ../hive-after 2f4477d649662ccc3a502c9916fa178053a35bf8
# Use the same installed dependency cohort in both worktrees; a local symlink
# is sufficient. This is a source-comparison run, not their historic lock installs.
ln -s "$PWD/node_modules" ../hive-before/node_modules
ln -s "$PWD/node_modules" ../hive-after/node_modules
node --import tsx scripts/benchmark-storage-matrix.mjs ../hive-before/src/server/hive.ts 12 > before.json
node --import tsx scripts/benchmark-storage-matrix.mjs ../hive-after/src/server/hive.ts 12 > after.json
```

An optional third argument selects a single fixture, e.g. `foreign-agents-50000`.
The default source is current `src/server/hive.ts`; such a run must be reported
separately because delivery and security evolved after #64. The harness imports
only the explicitly selected source tree; all databases and messages are temporary.
Samples must be 1–30. Large fixtures intentionally run outside the normal CI loop;
a small current-tree smoke test is discovered automatically.

## Regression gates and search decision

Current `query-contracts.test.ts` enforces exactly one roster query and two channel
queries with 50,000 unrelated agents/2,000 channels, bounded bind counts, correct
private/project permissions, invitation/restart behavior and complete delivery.
Receipt/bounds tests separately guard unchanged acknowledgement semantics. These
are deterministic work/correctness gates. Investigate an independently repeated
p95 regression above 2x the stored same-machine baseline before accepting a
performance change; absolute cross-runner timings are not flaky CI pass/fail gates.

A direct `CREATE VIRTUAL TABLE ... USING fts5` probe returned `no such module:
fts5` in the **specific minimum-runtime build tested**; its ENABLE_FTS5 compile
option was 0. This is not a claim about every Node/SQLite distribution. Keep the
current authorized substring/sequence search rather than silently requiring an
unavailable module or changing search matching semantics. Any later FTS prototype
must retain a compatibility path and independently test the documented matching
and authorization contracts.
