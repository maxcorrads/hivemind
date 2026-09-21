# Phase 2 classifier evidence

Related: #29, #35, #128/#129. This collector measures the existing controller; it does not change Jev's schedule, topology policy, confidence thresholds, locks, or fallback behavior.

## Capture boundary

Each initial or continuous classifier attempt is recorded before awaiting the provider. Its outcome is saved before the controller checks for a capacity race or stale configuration/revision. Thus an extra classification due to changing worker availability, or a result discarded after key rotation, still contributes to observed overhead.

The evidence is separate from ordinary messages, task records and the Human routing timeline. It is not returned by agent APIs and does not consume agent inbox/context. No new provider call is made to collect or export evidence. Disabling Jev continues to bypass external classification.

The numeric/enum projection contains current/target topology and worker counts, confidence, provider-reported token usage, resolved model identifier and local classifier latency. It does not store request text, configuration/key objects, project/worker names, attachment contents or raw provider errors. Local database rows contain execution/channel IDs for correlation and cascading cleanup; the export replaces those with a file-local execution alias.

## Bounded persistence

`adaptive_evidence_runs` retains the most recent 50 recorded executions per channel. `adaptive_evidence_attempts` retains the last 500 attempt details per execution. Aggregate counters survive detail pruning; `prunedAttempts` and `historyComplete` make the loss of older detail explicit. Channel deletion cascades to both tables transactionally.

Pending attempts are retained as unknown outcomes, not free calls. A crash after the remote request but before outcome persistence cannot establish usage or billing; the pending count remains visible. No external exactly-once billing claim is made. The detail cap also applies to repeated interrupted attempts.

Collector write errors produce sanitized server warnings but never block or change the Human request. A run with recorder errors must be marked instrumentation-incomplete in an experiment and excluded from complete-overhead claims. The counters describe recorded attempts, not an independently reconciled provider invoice.

Historical runs without this recorder have unknown measurements. There is no fabricated backfill from the latest recommendation, and absence of an evidence record is not evidence of zero router cost.

## Offline export

From a repository checkout with its normal dependencies installed, obtain the execution ID from the local Human Routing state, then run:

```sh
node --import tsx scripts/export-topology-evidence.mjs \
  --db /absolute/path/to/hivemind/hive.db \
  --execution execution-<id> \
  --output /absolute/path/to/new-evidence.json
```

This is a local Human/operator command, not an agent tool. SQLite is opened **read-only**, using one read transaction so counters and detail belong to the same snapshot. The output must be a new file and is created with mode `0600`; existing evidence is never overwritten. The command performs no migration, provider request, trial execution or upload.

Exports use `schemaVersion: 1`, `evidenceClass: adaptive-evidence-v1`, `contractVersion: adaptive-routing-v2`, and the exact policy version. Retained resolved model identifiers are exposed to detect mixed-model observations; more than 16 distinct identifiers sets `modelsTruncated` instead of claiming an exhaustive model list.

## Interpreting the report

- `attemptsStarted` / `attemptsFinished` count classifier attempts, not verified billable HTTP calls or applied policy changes.
- `knownInputTokens` / `knownOutputTokens` sum only reported observations. Complete totals are **null** if any attempt lacks usage.
- `pendingAttempts` and `unknownUsageAttempts` are distinct from successful calls with reported zero usage.
- `summedLatencyMs` adds observed classifier durations only when all attempts have a duration. It is **not** task wall time and must not be added again to an end-to-end wall measurement.
- `policyEvents` is an allowlisted projection of the existing retained Human routing audit. Its coverage is always labelled `retained_tail_only`; it is not a new complete transition ledger.
- Monetary cost remains null. No vendor pricing or conversion from message bytes is guessed.

The report does not judge task quality, correctness of a downgrade, or under-orchestration by itself. Those labels need comparable reviewed execution results. A failed workload, an unavailable classifier, a lost measurement, and a poor routing choice must remain separate outcomes.

For clean fixed-mode baselines, disable Jev monitoring explicitly. A manual Single/Room lock with Jev still enabled remains a monitored execution and does not establish zero-router overhead.

## Validation

Tests use fake TypeSafe responses and local SQLite/HTTP boundaries only. They cover complete/unknown usage, duplicate outcome persistence, hard detail/run caps, pending interruptions, cascading cleanup, private allowlisted export, read-only/non-overwriting CLI behavior, stale-key and capacity-retry accounting, context isolation and recorder failure. They are not live provider calibration or measured economic benefit.
