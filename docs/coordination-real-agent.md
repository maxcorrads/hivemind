# Real-agent coordination trials

This is phase 2 of issue #29. Phase 1 defines deterministic fixtures and protocol smoke coverage; this runner prepares and validates trials performed by actual model/provider sessions without making Hivemind depend on a provider SDK or CLI.

The goal is to compare the same fixture under four coordination shapes: `single_worker`, `brain_one_worker`, `brain_multi_dm`, and `brain_multi_room`. Results stay multi-dimensional. There is deliberately no aggregate score and no automatic “winner”.

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
