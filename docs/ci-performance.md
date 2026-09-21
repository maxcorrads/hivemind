# PR CI performance baseline and topology

Issue #113 optimizes pull-request feedback for wall-clock latency while preserving the existing test, coverage, browser, dependency-review and Node compatibility contracts.

## Before baseline

The baseline uses the five most recent successful **attempt-1** PR CI runs before this change: #106 through #110 on 2026-09-21. #111 is excluded because its final workflow state is a selective rerun (attempt 2), which would mix first-attempt and rerun timing.

| Metric | Baseline |
| --- | ---: |
| PR CI wall-clock median | 210 s |
| PR CI wall-clock p90 | 614 s |
| Runner time median per PR | 458 s / 7.63 min |
| Runner time p90 per PR | 549 s / 9.15 min |
| Tests / Node 24 median job | 90 s |
| Tests / Node 22.13.0 median job | 150 s |
| Coverage median job | 152 s |
| Browser / Chromium median job | 42 s |
| Quality / build / package median job | 23 s |

Wall-clock is workflow `run_started_at -> updated_at`. p90 uses nearest-rank because the sample is intentionally small and recent. The 614 s sample is a real queue/provisioning outlier and is retained rather than discarded.

Median Node 24 step timing makes the duplicated/serial cost visible:

| Step | Median |
| --- | ---: |
| `npm ci` | 4 s |
| Unit contracts | 3 s |
| Integration contracts | 75 s |
| Separate full coverage collection | 132 s |
| Chromium install | 11 s |
| Browser contracts | 14 s |

So dependency installation is measurable but not the critical path. Integration and the duplicate full coverage run are.

## Historical timing weights

Five recent Node 24 logs were also sampled for stable slow test cases and mapped back to their containing file. The checked-in `scripts/ci-test-timings.json` contains the resulting lower-bound historical weights. The largest observed file weights are:

| Integration file | Historical weight |
| --- | ---: |
| `src/server/names-hive.test.ts` | 18.86 s |
| `scripts/quality-contract.test.mjs` | 10.96 s |
| `src/server/browser-security.test.ts` | 10.59 s |
| `web/extensibility-workflows.test.ts` | 5.15 s |
| `src/server/inbox-bounds.test.ts` | 3.75 s |
| `src/server/dependency-concurrently.test.ts` | 2.74 s |
| `src/server/query-contracts.test.ts` | 2.49 s |
| `src/server/decisions.test.ts` | 2.39 s |
| `src/server/history-contracts.test.ts` | 2.00 s |

These are scheduling weights, not claims that they capture every millisecond in a file. Unmapped/new integration files receive a deterministic fallback weight and are still assigned to exactly one shard.

## New topology

- Node 24: unit and four timing-balanced integration shards run independently.
- Node 22.13.0: the same full unit/integration scope is retained and integration is split into two timing-balanced shards. Compatibility coverage is **not** reduced to a smoke subset; the lower shard count deliberately limits setup/queue overhead on the compatibility runtime.
- The historical required gates `Tests / Node 24` and `Tests / Node 22.13.0` remain as aggregation jobs that require every corresponding unit/shard job.
- Normal Node 24 unit/integration jobs collect LCOV alongside their ordinary redacted logs. A lightweight `Coverage` aggregator merges those artifacts and enforces the unchanged 80% line / 75% branch / 75% function thresholds. There is no third full test execution in CI.
- Playwright browser downloads are cached by OS + lockfile and installed only on a cache miss.
- setup-node's npm download cache is enabled; `node_modules` is not cached.
- Browser contracts remain isolated from server integration shards.
- PR-title and dependency-review checks run on Ubuntu because they have no macOS dependency, leaving scarce macOS capacity to the tests that actually require it.
- Failed suite logs remain redacted and retained independently, so a shard failure names the responsible shard immediately.

The extra shard setup intentionally trades some runner-minutes for lower critical-path latency. The baseline above keeps runner cost visible so that trade can be reviewed rather than hidden.

## Tuning observation

The first validation run of the initial 4+4 shard topology was CI run `35604713765` on PR #117 (commit `ff5161f`). Every check passed, including merged coverage at **93.20% lines / 76.01% branches / 90.48% functions**.

That run recorded **533 s wall-clock**, **552 runner-seconds**, and a **477 s maximum job queue**. The queue therefore dominated wall-clock far more than execution time. Rather than hide that result, the final topology reacts to it: Node 22 keeps the full integration suite but uses two shards instead of four, and the PR-title/dependency-review checks move off macOS. This run is a tuning observation, not part of the final after-sample because it used the superseded 4+4 topology.

## After measurement

Do not infer the target from the topology alone. Record successful attempt-1 runs of this branch/revision using the same definitions above. The first PR run is useful as an immediate sanity check; median and p90 should be updated from at least five successful attempt-1 runs before claiming the issue's 30% median target as demonstrated.
