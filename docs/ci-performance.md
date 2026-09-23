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

The checked-in weights come from five recent Node 24 logs and retain the deterministic assignment already validated with merged LCOV. Ubuntu timings are recorded separately for future balancing work so performance tuning cannot silently change effective coverage accounting. The largest observed file weights are:

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

- Ubuntu is the primary CI platform for quality/build/package, Node tests and Chromium. This avoids scheduling the parallel shard fan-out against the much smaller hosted macOS concurrency pool.
- Node 24: unit and four timing-balanced integration shards run independently on Ubuntu.
- Node 22.13.0: the same full unit/integration scope is retained on Ubuntu and integration is split into four timing-balanced shards. Compatibility coverage is **not** reduced to a smoke subset; the earlier two-shard compromise was only necessary while the fan-out competed for scarce macOS runners.
- One focused `macOS compatibility` job runs the launch/plugin shell contracts with native macOS zsh. Linux uses bash for the cross-platform shell argument contracts and does not install zsh on every ephemeral runner; zsh-only syntax validation remains native to macOS.
- The historical required gates `Tests / Node 24` and `Tests / Node 22.13.0` remain. `Tests / Node 24` aggregates its unit/integration producers, the native macOS compatibility job **and** `Browser / Chromium`, so branch protection cannot silently omit the platform or browser checks.
- Normal Node 24 unit/integration jobs collect LCOV alongside their ordinary redacted logs. A lightweight `Coverage` aggregator merges those artifacts and enforces the unchanged 80% line / 75% branch / 75% function thresholds. There is no third full test execution in CI.
- Playwright browser downloads are cached by OS + lockfile and installed only on a cache miss. Ubuntu installs the required Chromium system dependencies explicitly.
- setup-node's npm download cache is enabled; `node_modules` is not cached.
- Browser contracts remain isolated from server integration shards.
- PR-title and dependency-review checks run on Ubuntu as well; the only macOS runner is the focused compatibility job.
- Failed suite logs remain redacted and retained independently, so a shard failure names the responsible shard immediately.

The extra shard setup intentionally trades some runner-minutes for lower critical-path latency. The baseline above keeps runner cost visible so that trade can be reviewed rather than hidden.

## Tuning observation

The first validation run of the initial 4+4 shard topology was CI run `35604713765` on PR #117 (commit `ff5161f`). Every check passed, including merged coverage at **93.20% lines / 76.01% branches / 90.48% functions**.

That run recorded **533 s wall-clock**, **552 runner-seconds**, and a **477 s maximum job queue**. The queue therefore dominated wall-clock far more than execution time. Rather than hide that result, the final topology reacts to it: Node 22 keeps the full integration suite but uses two shards instead of four, and the PR-title/dependency-review checks move off macOS. This run is a tuning observation, not part of the final after-sample because it used the superseded 4+4 topology.

A later 4+2 validation on PR #119 (run `35607991015`) was fully green but still used macOS for the heavy jobs. It recorded **200 s wall-clock**, **NaN runner-seconds**, and a **NaN s maximum job queue**. The queue appeared after the workflow exposed more runnable macOS jobs than the hosted pool could start at once. That observation motivated the Linux-first topology above; it is also excluded from the final after-sample because it predates that topology.

## After measurement

Do not infer the target from the topology alone. Record successful attempt-1 runs of this branch/revision using the same definitions above. The first PR run is useful as an immediate sanity check; median and p90 should be updated from at least five successful attempt-1 runs before claiming the issue's 30% median target as demonstrated.

## Linux timing observation

Two successful Ubuntu attempt-1 runs of the four-shard Node 24 plan measured materially different shard runtimes from the original scheduling signal. A trial that immediately rescaled and reassigned files improved balance, but also changed the merged LCOV branch universe enough to produce **74.9968%** raw branch coverage (displayed as 75.00%), correctly failing the unchanged 75% threshold. The threshold was not rounded down or weakened.

The final topology therefore keeps the previously validated Node 24 assignment while retaining the measured Ubuntu timings as evidence for a follow-up adaptive balancer coupled to coverage-stable source identity. Node 22 still moves from two to **four** Ubuntu shards because that cuts its critical path without affecting the Node 24 coverage producer partition.

## Node version lanes and minimum-version plan

Issue #160 adds a `22.x` lane next to the `22.13.0` floor: the Node 22 unit job and its four integration shards run as a `node × shard` matrix, so CI tests 22.13.0 (the `engines` minimum), the latest Node 22 release and Node 24. Storage relies on `node:sqlite` (`DatabaseSync`), which is still experimental in Node 22; the latest lane surfaces behaviour changes in newer 22 minors before users hit them. Both Node 22 lanes feed the historical required check `Tests / Node 22.13.0`, whose name is kept for branch protection. The extra lane adds five short Ubuntu jobs that run in parallel with the existing ones: more runner-minutes, no extra critical-path latency.

Node 22 reaches end of life in **April 2027**. Plan:

- Until then, keep `engines.node` at `>=22.13.0` and keep both the floor and the `22.x` lane.
- At Node 22 EOL, raise `engines.node` to the tested Node 24 floor, replace the Node 22 lanes with that floor plus a `24.x` latest lane, add the next LTS line as the current lane, and update the required status checks in the `main` ruleset in the same change.
- Dependabot (`.github/dependabot.yml`) opens weekly grouped patch/minor PRs for runtime and development npm dependencies, plus GitHub Actions updates; major updates arrive as individual PRs.
