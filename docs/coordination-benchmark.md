# Coordination benchmark

Issue #29 needs evidence about when coordination primitives help, hurt, or merely add traffic. The benchmark is intentionally split into two evidence classes.

`synthetic_contract` is the phase-1 harness in this change. Fake-agent fixtures use virtual ticks and deterministic accounting to lock down scenario definitions, randomised trial order, metric names, budgets and JSON output. These numbers are **not** evidence of model quality, real latency, productivity, or token savings.

`real_agent` is reserved by result schema v1 for the follow-up trials that run actual agent/provider workflows. Those trials should reuse the same fixture IDs where practical, pin prompt/model/task versions, retain raw trial outputs, blind human review where practical and report uncertainty across repeated runs.

## Run

```sh
npm run benchmark:coordination
node scripts/benchmark-coordination.mjs --fixture blocked-worker-recovery --workflow brain_one_worker --seed 29
node scripts/benchmark-coordination.mjs --all --seed 29 --repeat 3 --output /tmp/hivemind-coordination.json
```

The default matrix compares `single_worker`, `brain_one_worker`, `brain_multi_dm` and `brain_multi_room`. Workflow order is shuffled reproducibly from the supplied seed. The harness never chooses an overall winner or emits a single aggregate score.

## Phase-1 fixtures

The v1 suite is intentionally small: independent parallel work, a strongly coupled shared-interface change, blocked-worker checkpoint/handoff recovery, offline plus dropped-delivery recovery, and peer clarification in a collaboration room. Together they cover structured tasks, checkpoint/handoff, advisory claims/dependencies, worker routing and collaboration rooms.

Fixtures live under `benchmarks/coordination/v1/fixtures`. Each records a schema version, fixture ID, task/prompt/model versions, task graph, fake worker capabilities, deterministic faults and explicit virtual-tick/communication budgets. Additions should stay bounded and should represent a materially different coordination shape rather than another copy of the same task.

## Metrics and interpretation

Results keep dimensions separate:

- quality: acceptance success, defects, duplicate work, unsupported completion claims, conflict/rework and routing misses;
- coordination: assignment-to-acceptance, blocker-to-decision, critical path, recovery, handoffs and clarification rounds;
- efficiency: model-returning wake-ups, communication bytes, context-expansion calls and provider usage;
- infrastructure: SQL/row, event-loop, delivery, memory and queue metrics when a runner can actually observe them.

Unavailable provider or infrastructure usage is `null`, never zero. Synthetic virtual ticks and bytes are contract-test inputs, not measured production performance. The storage/inbox benchmarks remain the source for current infrastructure-load measurements until a real-agent runner captures those fields directly.

## Follow-up real-agent protocol

The next #29 change should add an opt-in runner/importer for real agents rather than silently changing these synthetic fixtures. At minimum it should pin the Hivemind revision, provider/model and prompt version; repeat trials in seeded random order; retain per-trial acceptance artifacts and review defects; capture provider-reported usage when available; and report uncertainty instead of one headline score. A room/no-room comparison should use the same task fixture before making the #33 keep/simplify/defer decision.
