# Human decision queue

Hivemind can turn an explicit brain question into a task-bound Human decision request. This is a coordination record, not a second task state machine.

## Authority and lifecycle

Only the **assigning brain** may create a decision request for a structured task. The request is fenced to the exact task revision it was created from. Workers cannot create or withdraw requests; they escalate through their brain.

A request may be:

- `awaiting_input` — the task revision still matches and Human can answer;
- `answered` — Human replied to the decision root;
- `withdrawn` — the requesting brain explicitly withdrew it;
- `expired` — the optional requested-by time passed;
- `superseded` — the task revision changed or a newer request explicitly replaced it.

Expiry and recommendations never authorize an option automatically. Answering does not assign work, execute code, unblock a task, or mark it complete. The brain/worker must still perform the appropriate task event.

## Request shape

Use the MCP `request_human_decision` tool with:

- the current task ID and revision;
- one precise question;
- either no options or at least two options, each with its impact;
- an optional recommendation with rationale **and explicit uncertainty**;
- visible evidence sequence IDs and artifact references;
- the affected workers who already have access to the task channel;
- optional related decision IDs and an explicit superseded request;
- optional requested-by timestamp.

Related requests remain distinct records. A new request never silently merges several questions.

## Human queue and Telegram

The web UI exposes **Decisions** per project. Human can inspect impact, recommendation uncertainty, evidence/artifacts, affected workers and previous answers without opening unrelated channels.

Each decision is also a normal Hivemind root message. A Human reply in that thread is the answer. Telegram reply correlation therefore reuses the existing Telegram root mapping: replying to the mirrored decision root resolves the same decision ID.

A generic Human reply to an expired, withdrawn or superseded decision stays visible chat history but does **not** apply to the decision.

## Delivery receipts

An applied Human answer is explicitly routed to the requesting brain and affected workers. The decision view shows per-recipient:

- `pending` — no receipt offered yet;
- `offered` — included in an inbox delivery;
- `acknowledged` — that delivery was explicitly ACKed.

These are transport receipts only. They do not imply that the recipient accepted or acted on the answer.

## Retry and failure behavior

Creation, Human answer and withdrawal use request IDs. Exact retries return the prior result; reusing a key with another payload fails. Human answer and brain withdrawal are decision-revision fenced.

If the linked task revision changes while Human is deciding, the request projects as `superseded`. A dedicated answer endpoint then fails closed. Free-text replies are preserved as ordinary history rather than being silently applied to the new task revision.

## Paired Human evaluation

The functional queue is not by itself evidence that Human handling is faster or safer than the existing mention view. Issue #34 therefore has a small paired protocol dedicated to that remaining empirical question.

Version 1 contains four bounded cases: a current compatibility choice, a superseded task revision, related-but-distinct questions with repeated worker reminders, and an expired recommendation. Each case is shown in both `mentions` and `decision_queue` conditions, with two repeats by default: **4 cases × 2 conditions × 2 repeats = 16 trials**.

Trial packets omit the condition label, fixture ID and answer key. The presentation itself cannot be perfectly blinded because a decision card is visibly different from a mention stream; the manifest keeps the mapping and objective answer/context key separate from the participant packet.

The protocol measures dimensions separately:

- Human handling wall time;
- blocker-to-decision latency;
- repeated/follow-up question count;
- unrelated contexts opened;
- objective decision correctness;
- exact task/revision context correctness and wrong-context answers;
- independent evidence-support review.

It deliberately emits no aggregate score or automatic winner. A smaller local cohort is evidence about those cases and that participant cohort, not a general productivity claim.

Prepare the default cohort from the exact Hivemind revision under evaluation:

```sh
npm run benchmark:human-decisions -- prepare \
  --participant-cohort local-human-v1 \
  --hivemind-revision <exact-sha> \
  --output /tmp/hivemind-human-decisions
```

Present the generated `trial-*.json` packets in manifest order without exposing `manifest.json`. Retain interrupted runs as `status: "aborted"` rather than silently replacing them. For completed trials record real start/end timing, handling and blocker-to-decision milliseconds, the chosen action/option, exact task/revision, evidence references, repeated questions, unrelated contexts opened, and an evidence-support review. In the packet-only protocol the blocker becomes visible when the trial is presented, so blocker-to-decision will normally equal or exceed handling time; a live UI study may include real queue wait before presentation.

Validate and summarize after the cohort:

```sh
npm run benchmark:human-decisions -- validate \
  --input /tmp/hivemind-human-decisions

npm run benchmark:human-decisions -- summarize \
  --input /tmp/hivemind-human-decisions \
  --output /tmp/hivemind-human-decisions-summary.json
```

The summary keeps per-condition distributions and matched `decision_queue - mentions` deltas for time and interaction counts. Objective decision/context correctness is derived from the hidden manifest answer key; wrong-context answers are reported explicitly. Keep #34 open until a retained Human cohort exists.
