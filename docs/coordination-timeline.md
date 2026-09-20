# Coordination timeline and redacted replay

Issue #32 adds a bounded observability projection around existing Hivemind protocol state. It is **not** an event-sourcing rewrite and does not replace the structured-task tables.

## What is persisted

For new messages Hivemind keeps a small provenance row:

- trace ID;
- thread parent ID;
- optional explicit causal message ID;
- transport source (`hive`, `telegram`, `bot`);
- creation timestamp.

Structured task roots already use UUID task IDs, so their task ID is also the default trace ID. Replies inherit the root trace. Ordinary sends may opt into an unrelated trace with `traceId`.

`causeMessageId` is optional and must reference a message visible to the sender in the same project. The UI/export labels it **explicit**. Without it, a thread parent is shown as an **inferred** structural relationship; Hivemind does not claim semantic causation.

Inbox offers add bounded delivery metadata: delivery ID, recipient, message sequence, wake reason, offer/redelivery timestamps, attempt number and explicit ACK timestamp.

No hidden chain-of-thought, raw provider tokens, full local environment, repository contents or unrelated files are recorded.

## Timeline

For a visible structured task, `get_task_timeline` and the Human TaskCard show up to 500 events:

- task/message events, including assign/accept/block/checkpoint/result/review;
- durable transport source;
- explicit or inferred causal reference;
- delivery offer and acknowledgement;
- wake reason.

Timeline entries are observability facts only. They do not grant authority, change task state or prove that a reported check is correct.

## Redacted export and replay

`export_task_timeline` and the TaskCard export button produce schema v1 fixtures with `mode: "fake-only"`.

Redaction is structural:

- message body → SHA-256 + UTF-8 byte length;
- agent names/IDs → stable role aliases such as `brain-1`, `worker-1`;
- artifact strings → counts only;
- evidence references → sequence numbers only;
- credentials/secrets are never part of the schema.

Replay is pure local state reconstruction:

```sh
npm run replay:timeline -- ./hivemind-timeline-<task>.json
```

It never sends Telegram messages, opens network connections, launches agents or executes task code. It reports task-transition order, delivery/ACK counts, duplicate message IDs and orphan ACKs.

## Retention and bounds

The ledger has explicit hard bounds:

- max timeline events returned per trace: 500;
- provenance soft storage cap: 50,000 rows;
- delivery metadata soft storage cap: 100,000 rows;
- retention target: 30 days for completed/non-active traces.

Startup pruning and explicit pruning protect provenance for unfinished structured tasks. Deleting old observability metadata never deletes messages, task records, task events, attachments, or delivery receipts, so cleanup cannot complete/alter live work.

Old databases remain readable: when a provenance row is absent, task/thread structure is inferred from the authoritative message/task tables. Pre-feature Telegram origin cannot be reconstructed retroactively.

## Overhead measurement

Run:

```sh
npm run benchmark:timeline
```

The benchmark creates one 500-message trace, reports logical timeline metadata bytes, logical bytes per provenance row, and same-machine p50/p95 trace-query time. It also prints the enforced row/event caps and retention interval.

Timing is **observational**, not a cross-runner CI SLA. The regression test instead checks deterministic structural bounds (one compact provenance row per new message, hard caps, and bounded trace output).
