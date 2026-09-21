# Real-agent coordination trials

This is phase 2 of issue #29. Phase 1 defines deterministic fixtures and protocol smoke coverage; this runner prepares and validates trials performed by actual model/provider sessions without making Hivemind depend on a provider SDK or CLI.

The full matrix compares the same fixture under four coordination shapes: `single_worker`, `brain_one_worker`, `brain_multi_dm`, and `brain_multi_room`. Versioned focused presets may intentionally select a smaller workflow subset for a specific hypothesis. Results stay multi-dimensional. There is deliberately no aggregate score and no automatic “winner”.

## Pilot v1 — 24 trials

Before spending a full 96 real-agent runs, use the checked-in `pilot-v1` preset:

```sh
node scripts/benchmark-coordination-real.mjs prepare \
  --preset pilot-v1 \
  --provider <provider> \
  --model <exact-model-id> \
  --host <host> \
  --configuration <exact-host-model-configuration> \
  --hivemind-revision <main-sha> \
  --output /tmp/hivemind-pilot-v1
```

The preset is versioned at `benchmarks/coordination/v1/pilots/pilot-v1.json` and deliberately fixes:

- seed **29**;
- **2 repeats**;
- `independent-implementation` — parallelizable baseline;
- `shared-interface-coupled` — tightly coupled shared-interface work;
- `noisy-room` — communication stress and direct #33 DM-vs-room evidence;
- all four workflow shapes.

That produces exactly **24 trials** (3 fixtures × 4 workflows × 2 repeats). Provider/model/host/configuration are still mandatory because they are part of trial identity; the preset never invents them.

Treat this as a methodology pilot, not as sufficient evidence for a general productivity claim. Promote to the full 8-fixture × 4-workflow × 3-repeat = **96 trial** cohort only after the 24 runs reveal no systematic prompt/fixture/harness ambiguity and failed runs have been retained rather than rerun away.

## Clarification v1 — 6 discriminative trials

After `pilot-v1` established that the original tasks were single-session sufficient, use the focused `clarification-v1` preset instead of expanding blindly to 96 trials.

It fixes:

- one fixture: `room-peer-clarification`;
- workflows: `single_worker`, `brain_multi_dm`, `brain_multi_room`;
- two repeats;
- seed 29;
- exactly **6 trials**.

The fixture is information-partitioned. Each multi-agent worker seat receives one opaque fact in its private host prompt; the brain receives none. Every task output requires all three facts. Workers are instructed not to broadcast proactively: a missing fact must be requested through an explicit Hivemind question. DM runs therefore require brain relay; room runs can use addressed peer clarification. The single session receives the same complete information set in one prompt, so it remains a fair non-orchestrated baseline.

The shared runbook and workspace never contain the private fact values. The runner records only aggregate question-routing counts in run metadata; it does not copy fact/message bodies into those metrics.

Prepare and run with the same OpenCode/Muse cohort used by the initial pilot:

```sh
rm -rf /tmp/hivemind-clarification-v1

OPENCODE_BIN=opencode \
npm run benchmark:coordination:clarification -- \
  --provider opencode-go \
  --model opencode-go/muse-spark-1.3-contributor \
  --host opencode \
  --configuration auto \
  --output /tmp/hivemind-clarification-v1

OPENCODE_BIN=opencode \
npm run benchmark:coordination:run -- \
  --input /tmp/hivemind-clarification-v1
```

Afterward, compare the post-#121 tool-error count with the 48-error `pilot-v1` baseline:

```sh
npm run benchmark:coordination:mcp-errors -- --input /tmp/hivemind-clarification-v1
```

For each orchestrated trial, inspect `run-trial-*.json.coordinationEvidence`. A successful discriminative run should contain real worker `question` events. `peerDirectedQuestions` is the key room signal; `brainDirectedQuestions` is the expected DM-relay signal. Artifact acceptance remains independent of those counters.

### Executable v4 work contract

Real-agent prompt version `coordination-real-v4` / task version `coordination-task-v2` retains the deterministic SHA-256 artifact contract and adds optional information-partitioned material. Each task has a versioned base input and produces a lowercase SHA-256 value; dependent tasks hash the actual upstream outputs as part of their material. Partitioned fixtures additionally append canonical worker-fact pairs. The final artifact is a small JSON object containing every task output.

This gives the cohort a real acceptance check instead of asking a model to “implement” only an abstract effort/scope label. Expected hashes are computed by the harness and are **not** placed in participant prompts. In an information-partitioned run, the shared runbook also omits the fact values.

For `noisy-room`, the 12 unrelated observations apply only to `brain_multi_room`. The DM, brain+one, and single-worker conditions must not create a room solely to inject noise. This avoids the previous contradiction between “DM only” and “noise must stay in the shared room”. Because this changes participant instructions materially, old `coordination-real-v1` pilot directories must be regenerated rather than mixed into the v2 cohort.

### Optional Codex / OpenCode cohort executor

The core benchmark remains provider-neutral. The local executor supports both Codex and OpenCode cohorts:

```sh
npm run benchmark:coordination:run -- \
  --input /tmp/hivemind-pilot-v1 \
  --dry-run

npm run benchmark:coordination:run -- \
  --input /tmp/hivemind-pilot-v1
```

Codex uses `codex` by default and may be overridden locally with `CODEX_BIN`. OpenCode uses `opencode` by default and may be overridden locally with `OPENCODE_BIN`. Local executable paths are never persisted in the benchmark.

```sh
CODEX_BIN=/path/to/local-codex-wrapper \
npm run benchmark:coordination:run -- --input /tmp/hivemind-pilot-v1

OPENCODE_BIN=/path/to/opencode \
npm run benchmark:coordination:pilot:run -- --input /tmp/hivemind-pilot-v1
```

For an OpenCode + Muse Spark cohort, prepare a fresh cohort identity:

```sh
npm run benchmark:coordination:pilot -- \
  --provider opencode \
  --model opencode/muse-spark-1.3 \
  --host opencode \
  --configuration auto \
  --hivemind-revision <main-sha> \
  --output /tmp/hivemind-pilot-v1
```

The OpenCode runner invokes each seat with `opencode --pure run --dir <trial-workspace> --model opencode/muse-spark-1.3 --auto --format json`. `--auto` is part of the recorded cohort configuration and is rejected if the manifest does not record `configuration=auto`. The runner injects the Hivemind MCP via runtime OpenCode config for coordinated workflows and disables OpenCode's native `task` subagent tool so the measured multi-agent topology remains Hivemind's. OpenCode supports `provider/model` selection and `--auto` for non-interactive runs; see the upstream CLI documentation.

Executor behavior:

- trials run in the exact seeded manifest order;
- one trial runs at a time; seats within a multi-agent trial run concurrently;
- `single_worker` launches one host process with native subagents disabled and no Hivemind coordination;
- brain workflows launch one isolated host process per worker plus one brain, all with native subagents disabled, and coordinate only through Hivemind;
- the runner starts a fresh isolated Hivemind home per trial on port **7420** and retains its database/logs;
- the normal local Hivemind server must therefore be stopped while the pilot runs;
- Codex must already have the Hivemind MCP server configured for `http://127.0.0.1:7420`; OpenCode receives the isolated Hivemind MCP through runtime config generated by the runner;
- Codex benchmark seats override `memories.use_memories=false` and `memories.generate_memories=false` so prior Codex memory is neither injected into nor generated from the trial;
- OpenCode runs with `--pure`, an explicit isolated `--dir`, `--auto`, and its native `task` tool disabled;
- before each `brain_multi_room` seat starts, the isolated harness posts a real local Human authorization message into that trial's project and passes its positive message sequence to the brain; the brain must use that exact `humanInstructionSeq` when configuring the finite room, so it never blocks waiting for a Human process that is not part of the benchmark;
- finite room setup uses the first dependency-ready runbook task as the external origin task, then binds the room contract to that `originTaskId`; remaining room-bound assignments use the live contract version/action keys;
- worker capability cards mirror the versioned fixture capabilities;
- the brain assembles `BENCHMARK_RESULT.json` from reviewed worker results; the harness compares it with the hidden deterministic expected artifact;
- wall time is retained for both hosts; Codex CLI token counts are retained when available, while OpenCode JSONL `step_finish.part.tokens.total` is cumulative per seat, so the latest valid total is retained for each seat and seat totals are then summed across the trial;
- run logs, Hivemind state, final artifacts, and harness failures stay under the trial directory;
- a trial that has been attempted is skipped on resume rather than silently rerun away.

The executor intentionally leaves each trial `pending`. It fills only observed execution fields such as wall time, deterministic acceptance/defect count, and provider-reported tokens. Independent review must still fill rework/duplicate-work, clarification/handoff/recovery counts, review metadata, and finally set `status: "complete"`.

## Prepare a balanced trial set

```sh
node scripts/benchmark-coordination-real.mjs prepare \
  --provider openai \
  --model <exact-model-id> \
  --host <chatgpt|codex|other-host> \
  --configuration <reasoning=medium|host-default|...> \
  --repeat 3 \
  --seed 29 \
  --output /tmp/hivemind-real-agent
```

`prepare` writes one JSON template per trial plus `manifest.json`. Workflow order is shuffled reproducibly per fixture/repeat. Every template pins:

- Hivemind revision (from `git rev-parse HEAD`, or `--hivemind-revision`);
- provider, exact model, host and explicit model/host configuration;
- task and prompt protocol versions;
- fixture ID, workflow, seed and repeat index;
- a deterministic opaque `trialId` and separate `blindId`;
- the workflow-specific runbook prompt.

Run the generated prompts with real agents. The runner intentionally does **not** launch provider processes: Hivemind is provider-neutral, provider CLIs differ, and credentials/usage reporting belong to the host. This also avoids silently changing model parameters between providers.

## Complete a trial

Change `status` from `pending` to `complete` only after the run and independent review. Fill these fields from observed evidence:

- `timing.startedAt`, `timing.completedAt`, `timing.wallMs`;
- `quality.acceptancePassed`, `defects`, `reworkEvents`, `duplicateWork`;
- `coordination.clarificationRounds`, `handoffCount`, `recoveryEvents`;
- provider-reported `efficiency.providerTokens` and `providerCost` when available;
- `review.reviewer` and review notes.

Unknown provider usage stays `null`. Never derive token/cost numbers from message bytes, seniority, elapsed time or another provider's pricing. If cost is present, record its currency.

For review, use `blindId` as the artifact label and hide workflow/provider metadata where practical. The benchmark cannot force blinding when the artifact itself exposes coordination structure, so `review.blinded` records what actually happened rather than asserting perfect blinding.

## Validate and summarize

```sh
node scripts/benchmark-coordination-real.mjs validate --input /tmp/hivemind-real-agent
node scripts/benchmark-coordination-real.mjs summarize --input /tmp/hivemind-real-agent --seed 29 \
  --output /tmp/hivemind-real-agent-summary.json
```

Validation fails closed for malformed completed trials, negative usage/cost, missing version pins, and provider cost without a currency.

The summary first isolates exact provider/model/configuration/Hivemind/prompt/task cohorts, then groups by fixture and workflow and reports acceptance rate plus separate descriptive distributions for defects, rework, duplicate work, clarification/handoff/recovery counts, wall time, tokens and cost. For numeric metrics with at least two observed values it also emits a deterministic bootstrap 95% interval for the sample mean. These intervals describe the repeated trial sample; they are not guarantees about future tasks.

## Analyze recoverable MCP/protocol errors

The retained OpenCode JSONL seat logs can be scanned independently from quality review:

```sh
npm run benchmark:coordination:mcp-errors -- --input /tmp/hivemind-pilot-v1
```

The report counts model-visible tool errors by tool and by stable root-cause bucket. It intentionally counts recoverable errors even when final acceptance passes, because each failed tool turn can add latency and provider usage.

For the completed #29 `pilot-v1` cohort at Hivemind revision `24eb1b4a457001e4983d243c47a451b66a4c6e9e`, the baseline was 48 recoverable errors:

- 28 schema/invalid-argument errors;
- 10 visibility/reference errors;
- 7 room-state/reconciliation errors;
- 3 worker-name-vs-UUID capability lookup errors.

Use this report for matched before/after MCP ergonomics work. A lower count is useful only if authorization, revision fencing, room contracts, task review, and final acceptance remain unchanged.

## Experimental hygiene

Use the same repository/worktree state, fixture, model configuration and provider settings across workflow variants. Avoid tuning prompts after seeing one workflow's result; bump `--prompt-version` when instructions materially change. If task semantics change, bump `--task-version`.

Run enough repeats to expose variance. Three is a useful first pass, not a statistical guarantee. Preserve failed runs rather than rerunning them away; use a new repeat index for an explicit retry. Record provider outages or harness failures in review notes and distinguish them from task-quality failures.

The #33 room decision should use matched `brain_multi_dm` vs `brain_multi_room` trials on the same fixtures/model/version cohort. Look at quality, rework, clarification/handoff behavior, wall time and provider usage separately. A room may reduce relay traffic while increasing context cost, or the reverse; the harness intentionally preserves that trade-off instead of collapsing it into one score.


## Pilot execution checklist

For `pilot-v1`, keep one exact provider/model/host/configuration cohort for all 24 trials. Use the generated manifest order rather than choosing an easier workflow first.

For every completed run retain:

1. timestamps/wall time;
2. acceptance result;
3. independent review defects;
4. rework and duplicate-work counts;
5. clarification, handoff and recovery counts;
6. provider-reported tokens/cost only when actually available;
7. whether review was genuinely blinded.

After all 24 runs:

```sh
node scripts/benchmark-coordination-real.mjs validate --input /tmp/hivemind-pilot-v1
node scripts/benchmark-coordination-real.mjs summarize --input /tmp/hivemind-pilot-v1 --seed 29 \
  --output /tmp/hivemind-pilot-v1-summary.json
```

Review the three fixtures independently and keep dimensions separate. The pilot can expose methodological problems or large workflow differences, but it should not be converted into a single score or universal break-even threshold.
