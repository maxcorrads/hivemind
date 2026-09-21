# Coordination benchmark

Issue #29 needs evidence about when coordination primitives help, hurt, or merely add traffic. The benchmark is intentionally split into two evidence classes.

`synthetic_contract` is the phase-1 harness in this change. Fake-agent fixtures use virtual ticks and deterministic accounting to lock down scenario definitions, randomised trial order, metric names, budgets and JSON output. These numbers are **not** evidence of model quality, real latency, productivity, or token savings.

`real_agent` is reserved by result schema v1 for follow-up trials that run actual agent/provider workflows. Those trials reuse the same fixture IDs where practical, pin prompt/model/task versions, retain raw trial outputs, blind human review where practical and report uncertainty across repeated runs.

## Run

```sh
npm run benchmark:coordination
node scripts/benchmark-coordination.mjs --fixture blocked-worker-recovery --workflow brain_one_worker --seed 29
node scripts/benchmark-coordination.mjs --all --seed 29 --repeat 3 --output /tmp/hivemind-coordination.json
```

The default matrix compares `single_worker`, `brain_one_worker`, `brain_multi_dm` and `brain_multi_room`. Workflow order is shuffled reproducibly from the supplied seed. The harness never chooses an overall winner or emits a single aggregate score.

## Phase-1 fixtures

The v1 suite contains the eight scenario families required by #29: independent implementation, a strongly coupled shared-interface change, reviewer disagreement, blocked-worker checkpoint/handoff recovery, offline plus dropped-delivery recovery, a deliberately noisy room, peer clarification in a collaboration room, and a shared-worktree conflict. Together they cover structured tasks, checkpoint/handoff, advisory claims/dependencies, worker routing and collaboration rooms.

Fixtures live under `benchmarks/coordination/v1/fixtures`. Each records a schema version, fixture ID, task/prompt/model versions, task graph, fake worker capabilities, optional scenario instructions, deterministic faults and explicit virtual-tick/communication budgets. Additions should stay bounded and should represent a materially different coordination shape rather than another copy of the same task.

## Metrics and interpretation

Results keep dimensions separate:

- quality: acceptance success, defects, duplicate work, unsupported completion claims, conflict/rework and routing misses;
- coordination: assignment-to-acceptance, blocker-to-decision, critical path, recovery, handoffs and clarification rounds;
- efficiency: model-returning wake-ups, communication bytes, context-expansion calls and provider usage;
- infrastructure: SQL/row, event-loop, delivery, memory and queue metrics when a runner can actually observe them.

Unavailable provider or infrastructure usage is `null`, never zero. Synthetic virtual ticks and bytes are contract-test inputs, not measured production performance. The storage/inbox benchmarks remain the source for current infrastructure-load measurements until a real-agent runner captures those fields directly.

## Real-agent protocol

`scripts/benchmark-coordination-real.mjs` provides the opt-in `prepare → validate → summarize` workflow for actual model sessions. It pins Hivemind revision, provider/model/host/configuration and prompt/task versions, randomizes workflow order reproducibly, retains incomplete trials, and reports per-dimension uncertainty without an aggregate winner.

The versioned `pilot-v1` preset uses three representative fixtures, all four workflow shapes, two repeats and seed 29 for exactly 24 trials. It is methodology validation before a larger cohort, not evidence of multi-agent productivity by itself.

Prompt version `coordination-real-v2` gives each task a deterministic SHA-256 artifact contract so real sessions have an objective acceptance target. The optional `benchmark:coordination:pilot:run` command executes a Codex-hosted pilot with isolated Hivemind state and one external model process per actual workflow seat; native subagents stay disabled so the measured coordination shape remains Hivemind's. Local executable aliases are supplied only through `CODEX_BIN` and are not stored in the repository. See `docs/coordination-real-agent.md`.

## #32 timeline-diagnosis bridge

Issue #32 asks a narrower empirical question: whether persisted provenance makes representative coordination faults faster or more reliable to diagnose. `scripts/benchmark-timeline-diagnosis.mjs` reuses the #29 `offline-dropped-delivery`, `noisy-room` and `reviewer-disagreement` scenario families and creates paired baseline/timeline trial packets from the same redacted traces.

This protocol is intentionally separate from the workflow benchmark: it measures diagnosis accuracy/evidence support and wall time, not task execution productivity. Use the same pinned provider/model/host configuration as the relevant #29 cohort where possible, retain failed/incomplete runs, and leave unavailable provider usage as `null`. See `docs/coordination-timeline.md` for the runbook.
