# Coordination regression gates for #29

Issue #29 requires the optimizations tracked by #20, #21 and #27 to have an explicit baseline and regression threshold. The machine-readable contract is in `benchmarks/coordination/v1/regression-gates.json`.

The policy is deliberately conservative:

- **`ci_hard`** is only for deterministic operation counts, protocol counts, or explicit bounded constants already enforced by focused tests.
- **`investigate_only`** is for runtime timing. A controlled, independently repeated same-machine p95 above **2×** the retained baseline needs investigation, but absolute cross-runner timing is not a CI pass/fail gate.

This avoids converting noisy sub-millisecond or machine-sensitive measurements into flaky quality gates.

## #20 — scoped storage/query work

Retained measurement evidence is `benchmarks/results/storage-scoping-v1.json` and `docs/storage-benchmark.md`.

Hard gates retain the large-cardinality behavior already checked by `query-contracts.test.ts`:

- 50,000 unrelated agents: one roster statement execution.
- 2,000 unrelated channels: two channel-query executions.

The stored timing matrix remains descriptive. The 2× same-machine p95 rule is an investigation threshold, not a universal latency SLA.

## #21 — presence/realtime bounds

The baseline is the current deterministic contract:

- 10,000 redundant same-agent touches inside the heartbeat window: zero extra SQLite writes/broadcasts.
- exact 15,000 ms heartbeat boundary: one write and no visibility broadcast.
- outbound WebSocket buffered bytes: at most 1 MiB including the next payload.
- automatically retained live-message window: at most 500 messages; durable history remains available.

These are capacity/operation invariants rather than browser-throughput claims.

## #27 — notification/wake policy

The deterministic notification baseline remains:

- 20 acknowledgement-only messages: zero model-returning deliveries.
- routine progress batching: fixed at 250 ms from the first pending update.
- controlled one-task replay: 3 model-returning waits and 10 addressed wake signals, versus reference-policy 18/18.
- blockers and Human decisions: zero intentional fake-clock batching delay. The documented local operational target below one second applies only to an active idle waiter with capacity and is not an end-to-end SLA.

Real-agent token/cost/productivity comparisons remain separate #29 evidence and must not be inferred from these protocol gates.
