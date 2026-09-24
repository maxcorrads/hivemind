# Post-Phase-2 evaluation roadmap

Status reconciled on 2026-09-22 against `dc9323c650530e4d58be6dc15f2fbf7816c3aca3` (#129). This is an evidence plan, not a new feature specification or authorization to publish a release.

## Delivered versus unmeasured

| Track | Implemented | Remaining evidence / decision |
| --- | --- | --- |
| Original reliability/security work | #1–#18, #19–#28; integration reconciliation #65 | Normal regression coverage continues. |
| Task/claim/worker coordination | #26/#85, #28/#92, #30/#94, #31/#95 | Workload-specific benefit belongs in #29. |
| Causal timeline/replay | #32/#101 and follow-ups; #32 closed | Do not describe it as an unimplemented feature. |
| Collaboration rooms | #33/#85; selected as a Phase 2 option | Compare room versus DM where direct peer clarification is genuinely necessary. Human already chose to retain rooms as an optional mode. |
| Human decision queue | #34/#100 and paired protocol #124 | Real Human evaluation explicitly deferred by Human; no synthetic Human results. |
| Jev Phase 1/2 | #120/#126 and #128/#129 | Live provider integration smoke, per-attempt overhead, matched quality/cost/latency and confidence calibration. |
| Stable release | #73 (0.2.0), draft | Publication requires a separate explicit Human decision. |

Issue references are in [the Hivemind repository](https://github.com/maxcorrads/hivemind/issues). #35 is the live roadmap index; it stays open while chosen evidence work remains active.

## Work that can proceed without credentials or Human trials

1. Preserve bounded, privacy-safe evidence for every classifier attempt, including failures, capacity retries and stale decisions discarded before applying policy. Separate attempts from accepted evaluations and actual transitions.
2. Export a versioned report without request text, credentials, worker names, project paths or provider response bodies. Make missing history and unknown usage explicit.
3. Prepare deterministic, offline Auto-versus-fixed experiment manifests and validators. Require complete matched cohorts and compatible pinned versions. Fixtures are software tests, not measured provider performance.
4. Add regression coverage for the selected 0.90 policy, direct jumps, Human locks, safe drains, provider failure and evidence isolation. Do not alter agreed thresholds to make evaluation easier. (Superseded by #211: Jev is advisory-only, so there is no applied policy, lock or drain left to cover; see [Jev advice](adaptive-routing.md).)
5. Review concrete remaining gaps and record focused issues with reproduction/evidence and acceptance criteria, avoiding duplicates of #29/#33/#34.

No live request, paid agent run, release, or merge is implicitly authorized by this plan.

## What the retained pilot establishes

The completed `pilot-v1` ran 24 trials across four fixed workflows. Its results and pinned versions are retained in #29. It is useful historical evidence about the tested workflows, not a Phase 2 controller calibration.

The room comparison did not force actual peer questions, so it cannot determine the room benefit for distributed complementary information. The merged #125 supplies a separate `clarification-v1` preset with six trials: Single / Multi-DM / Room, two repeats. Do not merge different prompt/task/model versions into one cohort.

The single baseline receives the complete information set. This tests room-vs-DM communication economics under the specified constraints; it is not proof that Single must fail on a generally available request.

## Future live execution checklist (not executed by this document)

### Integration smoke before economic claims

Human configures the TypeSafe key in **Adaptive routing** on their own instance. Never paste it into an issue, command transcript, fixture or commit. Jev stays optional: the toggle is under Human control, and with it off nothing calls TypeSafe.

Use disposable local workspaces and synthetic non-sensitive requests first. Check a simple request, a parallel request, a request needing shared decisions, and a provider-unavailable case. Confirm that the Human send is posted at once, the advice appears in the Routing log, and the owning brain receives `jevAdvice` with its next action on the request; nothing is applied (#211, #214). Record the exact Hivemind revision, resolved provider/model, policy/contract version, worker capacity and whether the result is a fake fixture or live observation.

A failed smoke is a test result, not a reason to silently rewrite or drop the trial. Do not turn on broad live experiments until the simple contract works with the actual configured provider.

### Existing fixed-topology clarification experiment

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

> **Not runnable on this build.** The comparison needs server-enforced fixed topologies, which were removed when Jev became advisory-only (#211); the paired-study runner (#136) was removed in #214. Use a Hivemind release before #211 to execute the #132 manifest.

The design: run the same reviewed workload set with `auto`, `single`, `brain_one_worker`, `brain_multi_dm`, and `brain_multi_room` in randomized repeated order, with fixed versions and equivalent initial capacity. Fixed-mode conditions disable Jev for a clean no-router overhead baseline. Do not use the fixed-workflow executor above for this comparison.

Compare acceptance and independent defects first, then net provider tokens and elapsed wall time. Do not add summed Jev call latency to wall time already measured end-to-end. Keep workload-model tokens and Jev tokens separate; add them only where both are complete and the comparison is meaningful. Unknown monetary cost remains null; no current vendor price is hard-coded.

Preserve workload failures, transport/harness failures, missing measurements, interrupted runs and review status. `Auto selected Single` is not automatically an under-orchestration error: it requires reviewed evidence that Single missed the quality target and a comparable orchestrated run succeeded. A controller recommendation alone cannot label that outcome.

## Human-dependent work intentionally deferred

#34's 16-trial Human comparison remains optional and deferred. It measures actual Human response time and context errors; an agent replay is not a substitute participant. This does not block use of the delivered queue.

The TypeSafe key is not yet configured in Human's instance. Engineering work and fake-provider CI proceed without it. Credential setup/live evidence and release approval are the only external boundaries in this plan; Jev is advisory-only and optional (#211, #214): there are no topology, de-escalation or lock decisions left to agree.

## Release readiness is separate from measurement readiness

A green implementation CI verifies contracts, not real-world savings. Keep #73 draft. Complete the live integration smoke and inspect its retained evidence before requesting a release decision; missing calibration must be disclosed rather than presented as a tested performance claim.
