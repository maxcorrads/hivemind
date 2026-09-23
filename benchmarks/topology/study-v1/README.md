# Phase 2 topology study v1: graded workloads (#29)

Paid real-agent comparison of **Auto (Jev)** against the four fixed topologies, run by the [paired-study runner](../../../docs/topology-study-runner.md) (#136) on the [#132 protocol](../../../docs/topology-comparison.md). Nothing in this folder runs a model. Only an explicitly authorized `run` spends.

## Why these workloads

`pilot-v1` (#29) passed 24/24 on small tasks. On those tasks the single session was about 6x faster and 4 to 8x cheaper than every orchestrated topology, with the same acceptance. Those tasks were below the delegation break-even point. This set grows in size and changes shape so the study can find where (and whether) orchestration starts to pay:

| # | Workload | What the agents build | Shape | Reference size* | Hidden cases |
| --- | --- | --- | --- | --- | --- |
| 1 | `small-duration` | `parseDuration()` for strings like `1h30m`, with strict validation | one function, one file | ~20 LOC | 16 |
| 2 | `medium-csv` | RFC 4180 CSV `parseCsv`, `stringifyCsv` and typed `toRecords`/`fromRecords` | 3 related modules plus tests | ~105 LOC | 23 |
| 3 | `large-parallel-toolkit` | LRU cache, semver parse/compare/ranges, text wrapping, Roman numerals, token-bucket rate limiter | 5 fully independent modules, each with its own test file | ~195 LOC | 32 |
| 4 | `large-coupled-invoicing` | invoicing engine: money, catalog, cart, discount rules, tax, invoice and render | 6 modules chained through shared Money and line shapes with shared half-to-even rounding | ~215 LOC | 35 |

\*Dense reference code without tests. Agent-written solutions with tests are typically 3 to 5 times larger.

Every request is self-contained. The runtime is plain Node.js 22+ ESM (`.mjs`) with `node:test`, with no npm packages and no network. The host gives every trial an **empty** `workspace/` and cannot seed files, so each workload is built from scratch. All seats share that workspace.

## Acceptance (`acceptance.mjs`)

The runner calls `node <acceptance> <workspace>` with only `PATH` in the environment. The runner copies the file **without its extension**, so it has no static imports and works as either module type. The last stdout line is `{"passed": boolean, "defects": integer}`; the line before it lists the individual failures.

- Hidden tests live inside the acceptance file. They are written to a temporary directory, never into the workspace, and import the workspace modules by path. Each case has a 5 s limit and the whole hidden suite 40 s. A hang or crash marks every case that did not run as failed.
- Defects are counted as follows: each failed hidden case is one defect, each missing required test file is one, a workspace with no `test/**/*.test.mjs` is one, and a failing or hanging agent test run (`node --test <files>`, 40 s) is one.
- `passed` means zero defects. The check runs within the host's 120 s acceptance timeout even in the worst case (40 s + 40 s).

`reference/` holds a full reference solution for each workload. Only `request.txt` and `acceptance.mjs` are listed in `plan.json`, and the runner copies only those two files into the run directory. Seats never see `reference/`.

Proof: `node --test scripts/topology-study-v1-workloads.test.mjs`. For each workload it runs the check against the reference (passes, 0 defects, workspace unchanged), an empty workspace (fails every case) and a deliberately broken variant with one realistic mistake (only partial defects):

| Workload | Reference | Empty | Broken variant (mistake → defects) |
| --- | --- | --- | --- |
| small-duration | pass, 0 | fail, 18 | duplicate units accepted → 2 |
| medium-csv | pass, 0 | fail, 27 | no quoting of leading/trailing spaces → 2 |
| large-parallel-toolkit | pass, 0 | fail, 38 | non-canonical Roman numerals accepted → 2 |
| large-coupled-invoicing | pass, 0 | fail, 37 | `Math.round` instead of half-to-even in `money.percentage` → 4 (also breaks `tax`) |

## Design

- **Conditions:** `auto` (Jev on, `routing: auto`), `single`, `brain_one_worker`, `brain_multi_dm`, `brain_multi_room`. Fixed conditions run with Jev off and a task-scoped Human lock.
- **Repeats:** 2. **Free workers:** 4. **Seed:** `20260923`. That gives 4 workloads × 2 repeats × 5 conditions = **40 trials** in randomized block order.
- **Seats:** brain plus 4 workers. Every seat uses opencode `opencode-go/muse-spark-1.3-contributor`, the same model as `pilot-v1` (`versions.provider = opencode-go`, `versions.model = muse-spark-1.3-contributor`). The host is `opencode/1.18.31`. `versions.configuration = auto` records opencode's `--auto` flag, as in `pilot-v1`. The seats run `--pure` with the native `task` subagent tool disabled.
- **Jev model:** not pinned. `versions.jevModel` is omitted, so trials use the `jev-latest` alias, and `expectedResolvedModel` is `null` (the first valid Auto trial pins the cohort's resolved model).
- **Policy:** `topology-policy-v2.1`.

### Limits: `wallMs = 5,400,000` (90 min), `workloadTokens = 8,000,000`

The #132 manifest has **one** `limits` pair for the whole study (`limits.wallMs` and `limits.workloadTokens`). Per-workload limits cannot be set inside one study. The cap is sized for the largest workload, so the small ones effectively have a looser runaway stop. The estimates below come from `pilot-v1` (single about 25 s and 22k tokens; orchestrated 2.5 to 4 min and 100k to 180k tokens across 5 seats, worst case 7 min and 227k):

| Workload | Expected single | Expected orchestrated (worst topology) | Cap if split per workload |
| --- | --- | --- | --- |
| small-duration | < 1 min, < 50k | ~5 min, ~250k | 20 min / 1.5M |
| medium-csv | 3–5 min, 150–400k | 10–15 min, ~1M | 40 min / 3M |
| large-parallel-toolkit | 8–15 min, 0.4–1M | 15–30 min, 1.5–3M | 90 min / 8M |
| large-coupled-invoicing | 10–20 min, 0.5–1.5M | 20–40 min, 2–4M | 90 min / 8M |

OpenCode reports each seat's cumulative `tokens.total`, which grows with every step's context. The token cap is therefore about 2x the largest orchestrated estimate. A trial stopped by a cap is retained as `interrupted`, with `wallExceeded` / `tokensExceeded` flagged, and never dropped. If you want the per-workload caps in the last column instead, prepare four one-workload studies (same parameters, one workload each). That produces four study IDs and four run directories.

## Prepare (credential-free, offline)

The manifest pins `hivemindRevision`, the exact commit containing this folder. `config.json` and `study.json` therefore cannot be committed with it: committing them would move `HEAD` away from the pinned revision and the runner would refuse (`checkout.revision`). They are generated per checkout (git-ignored here) and copied read-only into the run directory by `prepare`. The run directory lives **outside** the repository.

From a clean checkout at the study commit (`$REV`), with dependencies installed:

```sh
node benchmarks/topology/study-v1/make-config.mjs            # writes config.json (fails on a dirty checkout)
node scripts/benchmark-topology.mjs prepare \
  --input benchmarks/topology/study-v1/config.json --output benchmarks/topology/study-v1/study.json
npm run benchmark:topology:study -- prepare \
  --plan benchmarks/topology/study-v1/plan.json --run-dir <new run dir outside the repo>
npm run benchmark:topology:study -- validate --run-dir <run dir>
npm run benchmark:topology:study -- dry-run  --run-dir <run dir>   # wouldRefuse must be []
```

`make-config.mjs` reads `parameters.json` and `plan.json`, hashes `request.txt` / `acceptance.mjs` and takes `HEAD` as the revision. If any study file changes, you need a new commit, a new config, a new study ID and a new run directory. Never reuse one.

## Run (Human only, paid)

In your own shell, from that clean checkout at `$REV`, with the pinned `opencode` logged in to `opencode-go`:

```sh
# smoke: exactly one trial (the first in manifest order)
HIVEMIND_STUDY_TYPESAFE_KEY=<key> npm run benchmark:topology:study -- run \
  --run-dir <run dir> --authorize-paid-run <studyId> --max-trials 1 --watch

# full cohort; resumes after the smoke, skipping completed trials
HIVEMIND_STUDY_TYPESAFE_KEY=<key> npm run benchmark:topology:study -- run \
  --run-dir <run dir> --authorize-paid-run <studyId> --concurrency 10 --watch
```

`--concurrency 10` runs two manifest blocks (ten trials) side by side, with seat launches serialized; see [parallel blocks](../../../docs/topology-study-runner.md#parallel-blocks---concurrency-n). `--watch` is optional. It opens a read-only tmux view (`hivemind-study`) with one pane per seat and has no effect on trials ([runner doc](../../../docs/topology-study-runner.md#watching-a-run-live---watch)).

Then run `export`, have the results reviewed independently, and run `summarize` ([runner doc](../../../docs/topology-study-runner.md#export-and-review)). The key is only required while Auto trials remain. It is never passed to seats and is scrubbed from retained homes.

## Not part of this study

`clarification-v1` (#125) is the older fixed-workflow cohort (`scripts/run-coordination-pilot-codex.mjs`). It can use the same model, but it is prepared and run separately, and its results are never pooled with this study.
