# Phase 2 paired-study runner

> **Legacy since #211.** The study compares Auto against server-enforced fixed topologies, which were removed when Jev became advisory-only. The live host (`scripts/topology-study-host.mjs`) now refuses to run trials; `prepare`, `validate`, `dry-run`, `reconcile` and `export` still work on existing run directories, and `dry-run` reports this build's policy version (`topology-advisory-v1`) as a mismatch for manifests pinned to `topology-policy-v2.1`. To execute the study, use a Hivemind release before #211. See [Jev advice](adaptive-routing.md).

Related: #136, #29, #131, #132, #134, #135. `scripts/topology-study-runner.mjs` is the execution adapter between the immutable [#132 topology-comparison manifest](topology-comparison.md) and an isolated host. It replaces hand-transcribing settings, execution IDs, usage and artifacts into observations. It does **not** decide whether a study should run, review the results or summarize them. Summaries remain [`benchmark-topology.mjs summarize`](topology-comparison.md#validate-and-summarize), after independent review.

This runner is for the continuous-controller Auto vs four fixed topologies comparison only. The older `run-coordination-pilot-codex.mjs` executor (`pilot-v1` / `clarification-v1`, #125) is the fixed-workflow cohort, and it stays that. Do not relabel its results as controller evidence or pool the two.

## Actions and the paid boundary

| Action | Credentials | Network | What it does |
| --- | --- | --- | --- |
| `prepare` | none | blocked | Verifies the plan, the pending manifest and the input/acceptance bytes, then copies them into a **new** run directory (read-only manifest). |
| `validate` | none | blocked | Rechecks manifest bytes, study identity, artifact hashes, checkpoint journals and that trials were started in the randomized order. |
| `dry-run` | none | blocked | Shows the next pending trials and what `run` would apply (routing, lock, Jev toggle, capacity, attempt path), plus the checks `run` would refuse. It creates no attempt, spawns no host and reads no key. |
| `reconcile` | none | blocked | Human resolution of an ambiguous attempt as `interrupted` or `harness_failed`. |
| `export` | none | blocked | Writes a #132 study (only completed or reconciled trials observed) and a run report, both new files with mode `0600`. |
| `run` | Jev key for Auto; the seat host's own provider login | yes | The **only** paid path. |

In credential-free actions `fetch` and every outbound socket throw, and the live host module is never loaded. `run` refuses unless all of these hold:

- `--authorize-paid-run <studyId>` names exactly this study (shown by `prepare`, `validate` and `dry-run`);
- the manifest is `evidenceKind: "live"`: a synthetic manifest is never executed by the live host;
- `CI` is not set;
- `HIVEMIND_STUDY_TYPESAFE_KEY` is set whenever a pending Auto trial remains. The key is refused before any trial starts, is never passed to seats or the trial server environment, and is scrubbed from each retained trial home afterwards.

Tests and CI use fake hosts only: an in-memory host for the runner contract, and fake `opencode` seats plus a fake TypeSafe preload for the live host. Neither can reach a non-loopback address.

## Run plan

Prepare the manifest with `benchmark-topology.mjs prepare`, then write a plan next to it. Paths are relative to the plan file.

```json
{
  "schemaVersion": 1,
  "manifest": "study.json",
  "workloads": [{ "id": "my-workload", "input": "my-workload/request.txt", "acceptance": "my-workload/acceptance.mjs" }],
  "host": { "name": "opencode", "binaryVersion": "1.2.3" },
  "jev": { "expectedResolvedModel": null }
}
```

- The manifest's `versions.host` must be `<name>/<binaryVersion>`, e.g. `opencode/1.2.3`; `run` probes `--version` before every trial.
- The workload model is passed to the seats as `<versions.provider>/<versions.model>`; `versions.configuration` must record opencode's `auto` flag.
- The requested Jev model is the manifest's `versions.jevModel` (#134), saved into every Auto trial's isolated settings and read back before the request. A study without `versions.jevModel` requests the default `jev-latest` alias, which is not pinned.
- `expectedResolvedModel`, when set, is the only resolved Jev model accepted. When null, the first valid Auto trial pins the cohort's resolved model.
- The acceptance artifact is run as `node <acceptance> <workspace>` with only `PATH` in its environment and must print `{"passed": boolean, "defects": integer}` on its last line.

Only the `opencode` seat host is wired today. Adding another host means an explicit seat invocation, a version probe and a usage parser, not a relabelled existing runner.

## What happens per trial

Trials run strictly in manifest order. Before each one the runner re-hashes the manifest and both workload artifacts and compares the checkout (exact `HEAD`, no tracked changes), host version, policy version, requested Jev model and Jev credentials. Any mismatch is journalled as `preflight_drift` and stops the run before an attempt exists.

Each attempt then gets a fresh `trials/<trialId>/attempt-NNN/` directory with its own `home/` (`HIVEMIND_HOME`) and `workspace/`:

1. A new `hivemind serve` from this checkout starts on an ephemeral loopback port with that home.
2. **Auto** saves Jev enabled with the key and pinned model. **Fixed** conditions save Jev **disabled**. The settings are read back.
3. One brain and exactly `freeWorkers` worker seats are launched. The Human request is sent only when exactly one brain and `freeWorkers` online workers are present. Anything else is `aborted_before_request: capacity_mismatch`.
4. The workload input is sent verbatim to the brain's DM. Auto uses `routing: auto`. Fixed conditions use the condition as a Human topology with `lockScope: task`, so a clean baseline is never a monitored lock.
5. The runner waits for the execution to complete (the brain marks the request thread done), the wall budget, the token budget (sum of live cumulative seat totals) or a Human interrupt, then stops seats and server.
6. Evidence is read from the trial database read-only: the #131 export for the Auto execution, and a count of Jev calls, which must be zero for fixed trials. The acceptance check then runs.

End-to-end `wallMs` runs from sending the Human request to completion. It already includes the initial classification wait, so summed Jev latency is never added. `workloadTokens` is the sum of provider-reported seat totals (Jev usage is only in the router evidence); one unknown seat makes the total `null` with `workloadUsageSource: unknown`.

## Checkpoints, resume and ambiguity

Each trial has an append-only `journal.jsonl`. Every record is flushed to disk before the runner continues: `preflight_drift`, `started`, `aborted_before_request`, `completed`, `ambiguous`, `reconciled`. A crash that tears the last line leaves the attempt open.

- Re-running `run` skips completed and reconciled trials. It is idempotent once everything is done.
- `aborted_before_request` means the Human request was never sent (setup failure, capacity mismatch, settings drift). The attempt is retained and reported, and the next `run` starts a new attempt directory.
- A lost response after the request may have been sent (network error or server death during the send), an unexpected host error, or an attempt found `started` without a result on resume is **ambiguous**. The run stops and later runs refuse to continue past it. Nothing is resent.
- Inspect the retained attempt, then resolve it:

  ```sh
  npm run benchmark:topology:study -- reconcile --run-dir <run> --trial <id> \
    --resolution interrupted --initial-topology <topology observed in the attempt> --note "<why>"
  ```

  `--initial-topology` is only needed for Auto. The resolution records an unhealthy observation with unknown time and usage. A recovered result is reviewed separately and never substituted for the trial.

A Human interrupt (Ctrl-C) records the running trial as `interrupted` and stops. Budget overshoots are recorded, not dropped: a wall-budget stop is `interrupted`, and the report flags `wallExceeded` / `tokensExceeded`.

## Configuration drift is retained, not pooled

A completed trial whose actual configuration differs from the manifest keeps its full record in the journal but its observation is **withheld** from the exported study, and the run stops. The exclusions are: Jev toggled wrongly, Jev calls in a fixed baseline, capacity differing after the request, fixed topology not applied, unknown initial topology, Human routing overrides, a different workload model, a requested Jev model differing from the pinned one (settings read-back or evidence `requestedModels`), a resolved Jev model differing from the cohort pin, or a different policy version. A cohort with withheld trials cannot be summarized. Split it or prepare a new study.

## Export and review

```sh
npm run benchmark:topology:study -- export --run-dir <run> \
  --output /tmp/study-observed.json --report /tmp/study-report.json
node scripts/benchmark-topology.mjs validate --input /tmp/study-observed.json
```

The exported study passes `benchmark-topology.mjs validate`. It carries only relative `evidenceRef` values (`trials/<id>/attempt-NNN`). Raw logs, databases and workspaces stay local in the run directory. Every automated observation has `independentlyReviewed: false` and `routingReview: null`. `defects` is the automated acceptance count until an independent reviewer records their own. A reviewer writes a **new** study file with their defect counts, `independentlyReviewed: true` and any routing labels they can support. Only then does `summarize` accept it.

`instrumentationHealthy` is false for unknown usage, unknown wall time, sanitized collector warnings in the trial server log, pending Jev attempts, incomplete Jev history, or invalid/missing router evidence. For Auto trials it additionally requires the router export's `coverage.capture` to be `complete` (#135): an `incomplete` or `unknown` capture, or an export without capture state, is never healthy.

## Authorizing a paid run (Human only)

1. Choose a clean checkout at the manifest's `hivemindRevision`, with dependencies installed and the pinned `opencode` version logged in to the workload provider.
2. Run `prepare`, `validate` and `dry-run`; `wouldRefuse` must be empty.
3. Stop other Hivemind servers only if you want to. Trials use ephemeral ports and never touch `~/.hivemind`.
4. In your own shell (never in an issue, transcript or commit):

   ```sh
   HIVEMIND_STUDY_TYPESAFE_KEY=<key> npm run benchmark:topology:study -- run \
     --run-dir <run> --authorize-paid-run <studyId> [--max-trials 1]
   ```

   `--max-trials 1` runs a single trial, which makes a sensible retained smoke step.
5. `export`, have the results independently reviewed, then `summarize`.

No real run, provider call or result is part of this change.
