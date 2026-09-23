# Phase 2 matched topology comparison

Related: #29, #33, #35 and #128/#129. `scripts/benchmark-topology.mjs` prepares an immutable randomized trial manifest, validates supplied observations and summarizes matched outcomes. **It does not launch agents, call Jev, collect Human timings, or execute paid trials.** The existing host runner is a separate execution boundary.

This protocol evaluates the continuous four-topology controller, not the old binary shadow predictor. Do not pool its observations with `pilot-v1` or `clarification-v1` results merely because some mode names resemble one another.

## Five explicit conditions

Every workload/repeat block contains exactly one trial for each condition:

| Condition | Jev monitoring | Execution |
| --- | --- | --- |
| `auto` | Enabled | Live controller chooses and revalidates the feasible topology. |
| `single` | Disabled | Human-selected Single for the entire request. |
| `brain_one_worker` | Disabled | Human-selected Brain+1 for the entire request. |
| `brain_multi_dm` | Disabled | Human-selected Multi-DM for the entire request. |
| `brain_multi_room` | Disabled | Human-selected Room for the entire request. |

A manual mode with Jev still enabled is a **monitored fixed mode**, not a no-router baseline. The validator rejects it from this study. Such a condition can be a future separate experiment, not a silent replacement for a fixed baseline.

Prepare each trial in an isolated execution/workspace with identical initial available capacity, model/host settings and workload input. The brain remains responsible for subtasks and worker selection. Do not silently add Human overrides mid-Auto execution; a nonzero override count belongs in a separately designed condition.

## Prepare without credentials

The checked-in example is deliberately **synthetic**. Its request and acceptance text are tiny demonstration inputs, not a discriminative performance workload. Their exact UTF-8 SHA-256 digests include the trailing newline.

```sh
node scripts/benchmark-topology.mjs prepare \
  --input benchmarks/coordination/v2/example-plan.json \
  --output /tmp/hivemind-topology-new-plan.json

node scripts/benchmark-topology.mjs validate \
  --input /tmp/hivemind-topology-new-plan.json
```

This produces 10 **pending** trials: one example workload, five conditions, two repeats. All observations remain `null`. No model is invoked and no result or success is fabricated. Choose a new output path each time; outputs are created exclusively with mode `0600` and never overwrite evidence.

For a real study, create a separate configuration with:

- `evidenceKind: "live"`;
- an exact 40-character Hivemind commit SHA and the workload provider/model/host/configuration identifiers;
- optionally `versions.jevModel`: the Jev identifier saved in the Auto trials' settings (see [Jev model](adaptive-routing.md#jev-model-alias-or-pinned-identifier)). When set, every Auto trial's router evidence must record exactly that requested identifier; exports without requested models cannot join such a cohort;
- the supported policy version (`topology-policy-v2.1`);
- one to ten workloads, each with a stable ID/version and exact `inputDigest` / `acceptanceDigest`;
- one to ten repeats, a uint32 random seed, and the same initial free-worker count (2–254) for all conditions;
- positive explicit `limits.wallMs` and `limits.workloadTokens`.

The manifest pins the configuration digest and deterministic trial identities/order. The CLI does not dereference workload IDs, validate the real input files against the supplied hashes or enforce a host's runtime budget; the executor/reviewer must retain those artifacts. A future execution adapter must verify the hashes before starting and report overshoots without dropping failed trials.

The recorded Hivemind revision must include whatever recorder/runner was actually used. The example's revision is only a synthetic scaffold; do not reuse it as a claim about a different live checkout.

## Record observations without altering the design

After a separately authorized execution, populate only the corresponding trial's `observed` field. Preserve the study configuration, randomized order, trial IDs and all failed/interrupted trials. A corrected recording should be retained as a new file rather than silently replacing prior evidence.

Required observation fields:

| Field | Meaning |
| --- | --- |
| `evidenceKind`, `versions`, `freeWorkers` | Must exactly match the study's source kind, pinned versions and initial capacity. |
| `jevEnabled` | `true` only for Auto; `false` for every fixed baseline. |
| `initialTopology` | Actual applied initial topology, not merely the requested mode. Fixed trials must match their condition. |
| `routingOverrides` | Must be zero: unplanned Human mode changes require a different condition. |
| `outcome` | `passed`, `quality_failed`, `harness_failed`, or `interrupted`. |
| `independentlyReviewed` | Boolean; quality outcomes require review before summary. |
| `instrumentationHealthy` | Boolean; false for collector/usage failures or unverified completeness. |
| `wallMs` | Measured end-to-end elapsed time, or null when unavailable. Required for quality outcomes. |
| `workloadTokens` | Provider-reported total across workload sessions, excluding Jev tokens, or null. |
| `workloadUsageSource` | `provider_reported` only when the token total is known; otherwise `unknown`. |
| `defects` | Independent defect count, including defects found despite acceptance passing; null if not assessed. Required for quality outcomes. |
| `routerEvidence` | Auto: the embedded `adaptive-evidence-v1` export produced by the recorder/export tooling (#131), or null with unhealthy instrumentation. Fixed: null, because Jev is off. |
| `routingReview` | Null, or an object containing nullable Boolean `underOrchestration`, `prematureDowngrade`, `flapping` reviewer labels. |
| `evidenceRef` | Redacted relative artifact reference, with no URL credentials or parent traversal. |

Do not paste keys, prompts containing secrets, environment dumps or raw provider responses into the study. This format is a consistency validator, not a general-purpose secret scanner or independent attestation that supplied measurements are true.

### Review labels

Acceptance passing and zero independent defects are different measurements; both remain visible. An Auto quality failure is not automatically an under-orchestration diagnosis. Review the executed modes, task outcome and comparable orchestrated result before labelling that error. Use null when the available record cannot support a diagnosis. A topology recommendation or a switch count alone is not proof of flapping or a premature downgrade.

Harness failure and interruption remain explicit outcomes. They do not enter quality-comparable pairs or economic deltas, but are not discarded from the experiment's denominator or outcome counts.

## Validate and summarize

```sh
node scripts/benchmark-topology.mjs validate --input /tmp/hivemind-topology-observed.json

node scripts/benchmark-topology.mjs summarize \
  --input /tmp/hivemind-topology-observed.json \
  --output /tmp/hivemind-topology-new-summary.json
```

`validate` permits pending trials and reports expected/completed/pending counts. `summarize` rejects pending, missing, duplicate, reordered, changed-config or unreviewed quality records. CLI input files are bounded to 128 MiB to accommodate the full 10-workload, 10-repeat cohort, including each Auto trial's 500 retained attempt details, 500 retained policy events and 200-character model identifiers in the normal two-space JSON format. Input is read in 64 KiB chunks, so small studies do not reserve the full limit; parsing still holds the supplied JSON in memory. Larger or excessively padded files are rejected. The tool never fetches referenced files or network resources.

The summary reports `auto_minus_fixed` for each matched workload/repeat, then describes the retained pair deltas with mean, median, min/max and deterministic 2,000-resample bootstrap intervals when there are at least two observations. These are descriptive intervals for the supplied paired sample, not proof of generalization to other workloads or a universal optimal topology. Raw pair deltas and observation counts are included.

### No inflated savings

- Net tokens are `workloadTokens + Jev inputTokens + Jev outputTokens` for Auto; fixed router usage is zero only under the explicit Jev-off condition.
- Complete net comparisons require healthy instrumentation, known workload and router usage, exactly one known resolved Jev model, and an unpruned capture beginning at the initial attempt. Missing, truncated or mid-execution evidence suppresses the net delta instead of becoming zero cost.
- An export may acknowledge incomplete history even when no retained attempt was pruned, for example after its capture was recreated. Such exports remain valid observations but cannot establish complete net usage. Legacy exports claiming complete history are still checked for an initial first attempt before entering net comparisons.
- Distinct resolved Jev model versions cannot be pooled, and neither can distinct requested identifiers. `validate` reports `requestedModels` and `resolvedModels` separately. Preserve and split those cohorts; a mutable alias alone is not a reproducibility guarantee, and a pinned identifier is not assumed immutable either: drift in the resolved model still splits the cohort.
- End-to-end `wallMs` already includes classifier waits. Summed classifier latency is **not added again**.
- Efficiency deltas include only jointly acceptance-passing, independently reviewed pairs. Independent defect deltas remain visible alongside them; a faster result with more review defects is not automatically better.
- Quality regressions/improvements, harness/interrupted exclusions, exceeded budgets and unknown routing-review labels are separate counters.
- Monetary cost is null. Provider prices, billing reconciliation and price equivalence across tokenizers are not guessed.

## Boundaries still requiring real execution

This PR supplies the offline protocol and scorer, not a production host executor or ready-made real-agent result set. The example and unit tests use synthetic observations explicitly labelled as such. Actual workload execution, independent review and provider configuration remain separate. #34's Human study stays deferred; it is not replaced by this agent-topology experiment. #73 remains draft until Human authorizes a release.

Run `node --test scripts/benchmark-topology.test.mjs` for the focused local software contracts. The ordinary repository CI remains the full lint/typecheck/unit/integration/browser/coverage gate.
