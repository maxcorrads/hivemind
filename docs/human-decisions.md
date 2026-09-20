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
