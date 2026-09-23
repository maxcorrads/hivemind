# Phase 2 classifier evidence

Related: #29, #35, #128/#129. This collector measures the existing controller; it does not change Jev's schedule, topology policy, confidence thresholds, locks, or fallback behavior.

## Capture boundary

Each initial or continuous classifier attempt is recorded before awaiting the provider. Its outcome is saved before the controller checks for a capacity race or stale configuration/revision. Thus an extra classification due to changing worker availability, or a result discarded after key rotation, still contributes to observed overhead.

The evidence is separate from ordinary messages, task records and the Human routing timeline. It is not returned by agent APIs and does not consume agent inbox/context. No new provider call is made to collect or export evidence. Disabling Jev continues to bypass external classification.

The numeric/enum projection contains current/target topology and worker counts, confidence, provider-reported token usage, resolved model identifier and local classifier latency. It does not store request text, configuration/key objects, project/worker names, attachment contents or raw provider errors. Local database rows contain execution/channel IDs for correlation and cascading cleanup; the export replaces those with a file-local execution alias.

## Bounded persistence

`adaptive_evidence_runs` retains at most 50 recorded executions per channel. The active execution from the persisted routing lifecycle and the attempt currently being recorded are protected within that limit; the remaining runs are retained by their last recording time. Rejected initial requests cannot displace an ongoing execution, including after a server restart. Completed executions are eligible for normal retention. `adaptive_evidence_attempts` retains the last 500 attempt details per execution. Aggregate counters survive detail pruning; `prunedAttempts` makes the loss of older detail explicit. Channel deletion cascades to both tables transactionally.

`historyComplete` requires a `complete` capture: an initial attempt at ordinal 1, no pruned attempt detail and no collection gap. A capture that begins or resumes with continuous monitoring is incomplete even if all newly recorded attempts have known usage. This also prevents previously evicted evidence from being recreated as complete history. `usageComplete` (and thus `totalInputTokens` / `totalOutputTokens` / `summedLatencyMs`) additionally requires `aggregateCapture: complete`: pruned detail keeps exact lifetime counters, but any gap, mid-execution installation or unknown capture keeps the retained usage as `known*` only, never a full-run total.

Pending attempts are retained as unknown outcomes, not free calls. A crash after the remote request but before outcome persistence cannot establish usage or billing; the pending count remains visible. No external exactly-once billing claim is made. The detail cap also applies to repeated interrupted attempts.

Collector write errors produce sanitized server warnings but never block or change the Human request. The counters describe recorded attempts, not an independently reconciled provider invoice.

## Collector health and capture completeness

Collector health (#135) is tracked separately from Jev provider availability: a successful classification does not imply a successful measurement. The server keeps it in memory for the Human only; agents never see it, and no extra Jev call is made to produce it.

- **Failure.** A failed `begin` (including a store that cannot be opened) or `finish` cannot be recorded in the same failing database. The collector logs a sanitized warning, keeps the Jev decision, and holds a *gap marker* for that execution in a bounded in-memory set (64 executions; beyond that, a single overflow marker). Health becomes `degraded`.
- **Recovery.** Held markers are persisted, each in its own transaction, before the next evidence attempt, after each outcome, whenever the Human reads the routing view or collector health, and on graceful shutdown. A marker is written into the run's snapshot JSON (no schema change): it creates a gap-only record if the run does not exist yet. An overflow marker conservatively marks every record of a still-running execution and every record touched since the first untracked failure. A marker whose channel was deleted is discarded, since its evidence was deleted with it. Once nothing is held, health is `recovered` (it returns to `healthy` only on restart).
- **Residual limit.** A process crash (or a restart while the store still rejects writes) loses held markers. This is not fully observable: the next process reports `healthy` and cannot know about the lost failure. Some such losses are still caught conservatively (an execution whose first recorded attempt is continuous is `recorder_installed_mid_execution`; an attempt left pending is `attempts_pending`), but a lost continuous `begin` in an otherwise recorded execution can be missed. Do not export or score evidence while the collector is `degraded`: an offline export only sees persisted markers.

Each record is classified as:

| `capture` | Meaning | Reasons |
| --- | --- | --- |
| `complete` | Every attempt since the initial one is recorded, with an outcome. | none |
| `incomplete` | A known loss. | `collection_gap`, `history_truncated`, `recorder_installed_mid_execution` |
| `unknown` | Completeness cannot be established. | `attempts_pending`, `not_recorded`, `legacy_record`, `recorder_unavailable` |

Records written before this tracking existed are `legacy_record`: a silent write failure cannot be ruled out. The Human Routing panel shows each execution's capture state and a collector warning; the Routing log shows the collector warning. The realtime `evidence-health` event and `GET /api/ui/adaptive-routing/evidence-health` carry the categories and counters only, never database or provider errors.

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

Exports use `schemaVersion: 1`, `evidenceClass: adaptive-evidence-v1`, `contractVersion: adaptive-routing-v2`, and the exact policy version. Retained resolved model identifiers are exposed to detect mixed-model observations; more than 16 distinct identifiers sets `modelsTruncated` instead of claiming an exhaustive model list. `requestedModels` / `requestedModelsTruncated` list the Jev identifiers Hivemind requested (the alias or a pinned identifier), independently of the resolved models; each attempt carries `requestedModel` and `model`. Runs recorded before requested models were captured export `requestedModels: null` (unknown), not an empty list.

## Interpreting the report

- `capture` / `captureReasons` say whether the record is a complete, explicitly incomplete or unknown capture; `collectionGap` counts missed begins, missed finishes and unattributed failures from persisted gap markers. `aggregateCapture` ignores only pruned detail.
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
