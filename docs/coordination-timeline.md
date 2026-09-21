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

## Diagnosis evaluation bridge to #29

The functional timeline is not evidence that diagnosis is faster. The repository therefore has a separate paired protocol for the remaining #32 evaluation question.

Three versioned cases reuse representative scenario families already defined by #29:

- `offline-dropped-delivery`: lost first delivery / redelivery recovery;
- `noisy-room`: a routine room event wakes a worker and creates avoidable clarification;
- `reviewer-disagreement`: a result is explicitly caused by a superseded assignment after revision.

Each underlying redacted trace is presented in two conditions:

- **baseline**: message/task order, IDs, role aliases and inferred thread structure only;
- **timeline**: the same trace plus durable transport, delivery/ACK attempts, wake reason and explicit/inferred causality.

The default protocol is 3 cases × 2 conditions × 2 repeats = **12 paired trials**. Trial packets omit fixture IDs, condition labels and the answer key. The manifest keeps those fields for later analysis. The condition cannot be perfectly blinded because the treatment is the presence of timeline metadata; independent review can still be blinded to the manifest where practical.

Prepare a cohort using the same provider/model/host configuration as a #29 real-agent cohort:

```sh
npm run benchmark:timeline:diagnosis -- prepare \
  --provider openai \
  --model gpt-5.6-luna \
  --host codex \
  --configuration reasoning=max \
  --hivemind-revision <exact-sha> \
  --output /tmp/hivemind-timeline-diagnosis
```

Run the generated trial packets externally. For every trial retain failures and fill measured start/end/wall time, the diagnosis and evidence references, clarification rounds, provider-reported usage when available, and an independent correctness/evidence review. Unknown provider usage remains `null`.

Then validate and summarize:

```sh
npm run benchmark:timeline:diagnosis -- validate \
  --input /tmp/hivemind-timeline-diagnosis

npm run benchmark:timeline:diagnosis -- summarize \
  --input /tmp/hivemind-timeline-diagnosis \
  --output /tmp/hivemind-timeline-diagnosis-summary.json
```

The summary keeps accuracy, evidence support, wall time, clarification rounds and provider usage separate. It also emits paired `timelineMinusBaselineWallMs` observations for completed matched trials. It never chooses a winner or turns the dimensions into one score.

## Overhead measurement

Run:

```sh
npm run benchmark:timeline
npm run benchmark:timeline -- --output /tmp/hivemind-timeline-overhead.json
```

The benchmark creates one 500-message trace and reports logical timeline metadata bytes, logical bytes per provenance row, total/per-message write time, and same-machine p50/p95 trace-query time. The retained JSON also records Node version, platform and architecture plus the enforced row/event caps and retention interval.

Write timing includes the normal message write and timeline metadata together; it is **not** an A/B estimate of timeline-only cost. All timing is observational, not a cross-runner CI SLA. Regression tests check deterministic structural bounds and only assert that timing fields are valid measurements.
