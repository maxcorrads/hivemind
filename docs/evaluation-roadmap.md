# Post-Phase-2 evaluation roadmap

Status reconciled on 2026-09-22 against `dc9323c650530e4d58be6dc15f2fbf7816c3aca3` (#129). This is an evidence plan, not a new feature specification or authorization to publish a release.

## Delivered versus unmeasured

| Track | Implemented | Remaining evidence / decision |
| --- | --- | --- |
| Original reliability/security work | #1–#18, #19–#28; integration reconciliation #65 | Normal regression coverage continues. |
| Task/claim/worker coordination | #26/#85, #28/#92, #30/#94, #31/#95 | Workload-specific benefit belongs in #29. |
| Causal timeline/replay | #32/#101 and follow-ups; #32 closed | Do not describe it as an unimplemented feature. |
| Collaboration rooms | #33/#85; selected as a Phase 2 option | Compare room versus DM where direct peer clarification is genuinely necessary. Human already chose to retain rooms as an optional mode. |
| Routing advice (Jev) Phase 1/2 | #120/#126 and #128/#129 | Removed, with its evidence collection and study tools. Nothing is left to measure. |
| Stable release | #73 (0.2.0), draft | Publication requires a separate explicit Human decision. |

Issue references are in [the Hivemind repository](https://github.com/maxcorrads/hivemind/issues). #35 is the live roadmap index; it stays open while chosen evidence work remains active.

## Work that can proceed without credentials or Human trials

Review concrete remaining gaps and record focused issues with reproduction/evidence and acceptance criteria, avoiding duplicates of #29/#33/#34.

The other items of this list covered evidence, reports, experiment manifests and regression coverage for the routing advice. They went away with it.

No live request, paid agent run, release, or merge is implicitly authorized by this plan.

## What the retained pilot establishes

The completed `pilot-v1` ran 24 trials across four fixed workflows. Its results and pinned versions are retained in #29. It is useful historical evidence about the tested workflows, not a Phase 2 controller calibration.

The room comparison did not force actual peer questions, so it cannot determine the room benefit for distributed complementary information. The merged #125 supplies a separate `clarification-v1` preset with six trials: Single / Multi-DM / Room, two repeats. Do not merge different prompt/task/model versions into one cohort.

The single baseline receives the complete information set. This tests room-vs-DM communication economics under the specified constraints; it is not proof that Single must fail on a generally available request.

## Future live execution checklist (not executed by this document)

### Existing fixed-workflow clarification experiment

Before the live execution step, stop the normal local Hivemind server and confirm that port **7420** is free. The executor starts an isolated server on that fixed port; a collision is recorded as a harness failure. Attempted trials, including harness failures, are skipped on resume. If a collision has already affected a cohort, preserve it and prepare a new output directory after freeing the port. See the [real-agent executor runbook](coordination-real-agent.md#optional-codex--opencode-cohort-executor) for the remaining prerequisites.

From a clean checkout, choose a **new** output directory so previous evidence is preserved:

```sh
OPENCODE_BIN=opencode npm run benchmark:coordination:clarification -- \
  --provider <provider-id> --model <pinned-model-id> --host opencode \
  --configuration auto --output /tmp/hivemind-clarification-new-run

# Separate, explicit live execution step; not part of prepare or CI:
OPENCODE_BIN=opencode npm run benchmark:coordination:run -- \
  --input /tmp/hivemind-clarification-new-run

npm run benchmark:coordination:mcp-errors -- \
  --input /tmp/hivemind-clarification-new-run
```

Check the selected installed host/provider configuration before running. No provider availability, price, or successful execution is assumed here.

### Matched Phase 2 comparison

> **Not runnable on this build.** The comparison needed server-enforced fixed workflows and an automatic mode chosen by the routing advice. Both were removed (#211, #214, and the removal of the advice itself). Use a Hivemind release before #211 to execute the #132 manifest.

## Human-dependent work intentionally deferred

#34's 16-trial Human comparison remains optional and deferred. It measures actual Human response time and context errors; an agent replay is not a substitute participant. This does not block use of the delivered queue.

Release approval is the only external boundary left in this plan.

## Release readiness is separate from measurement readiness

A green implementation CI verifies contracts, not real-world savings. Keep #73 draft. Inspect the retained evidence before requesting a release decision; missing calibration must be disclosed rather than presented as a tested performance claim.
