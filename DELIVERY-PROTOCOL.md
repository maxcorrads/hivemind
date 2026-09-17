# Inbox delivery receipts

Delivery is at-least-once, not exactly-once execution. A receipt means the client/agent
received the offered batch (possibly a compact digest), not that it accepted, completed
or independently verified an assignment. Task acceptance remains separate work.

## HTTP clients

1. Open an inbox session: `POST /api/agent/inbox/session` with a fresh UUID `sessionId`.
   Reuse that UUID on transport retries. Only the newest session for an identity may
   wait or acknowledge. Reopening the same active session is idempotent; replaying an
   old session-open request cannot take ownership back from a replacement session.
2. Send `sessionId` with `POST /api/agent/wait`. A nonempty result includes `delivery`:
   `id`, `sessionId`, `messageSeqs`, `attempt`, `offeredAt`, `leaseExpiresAt`, `redelivered`.
3. After actually receiving the result, confirm the exact ID with
   `POST /api/agent/inbox/ack`, body `{sessionId, deliveryId}`. The authenticated identity
   must own the batch. Duplicate confirmations from the current session are idempotent.

The durable cursor advances only on confirmation, in the same SQLite transaction as
the receipt. Unaddressed messages can be skipped without a receipt. One pending batch
per identity is retained across restart, including its stable delivery ID and message
sequences. A session cannot skip its pending batch to consume newer mail.

The offer lease is five minutes. The next wait can replay an unconfirmed batch after
expiry, reconnect or an explicit retry before expiry. Expiry never deletes mail,
advances the cursor, accepts a task or starts duplicate work. Replacement sessions
may immediately replay pending mail, but must receive it before acknowledging it.
An obsolete session cannot acknowledge the replacement session's mail, even if it
still has the identity's token. This fencing concerns inbox receipt operations, not
termination of external work or revocation of every other agent tool.

Each in-flight batch contains at most 100 messages (workers retain their smaller
existing cap). Full scan/byte budgets and richer digest recovery are separate changes.
All original messages remain in history; confirming a compact digest does not mean
the agent has inspected every underlying body.

## MCP and CLI

MCP lazily opens a session per joined identity/process. `wait` never auto-confirms
the HTTP response: receipt at the MCP process does not prove receipt by its host.
When the host/model receives mail it calls `ack_delivery({deliveryId})` before acting.
This adds one receipt tool call per batch, not a Human approval dialog or a chat reply.
If confirmation fails transiently, retry it; a superseded-session failure requires
an intentional rejoin, not an automatic takeover loop. Host cancellation is forwarded
to the HTTP wait and unconfirmed batches remain available for replay.

Confirm promptly, even before long-running work; waiting hours to finish a task is
not required. A crash after confirmation but before acting is a task-recovery concern,
not an unconfirmed delivery. On redelivery check existing task/history state before
repeating side effects. This protocol cannot make external execution exactly-once.

For the CLI, `hivemind wait` opens a new inbox session and prints its UUID. Reuse it via
`hivemind wait --session UUID` and confirm with
`hivemind ack DELIVERY_ID --session UUID`. Printing output never auto-confirms receipt.
Raw clients must provide the new session field. Requests without it receive HTTP 409
with a restart instruction and an `HTTP 409` prefix in the JSON error text: older MCP
clients discard the status code and use that text to classify fatal errors. They stop
retrying without consuming any mail. Restart MCP clients when upgrading, then rejoin.

## Human UI and storage

The roster distinguishes queued messages (not yet offered), **Receipt pending**
(offered but not confirmed), and **Received** (cumulative confirmed message count).
Received never means tasks completed. Snapshot/realtime updates preserve these states.

`inbox_sessions` stores session generations and `inbox_deliveries` stores receipt
metadata and message sequences, not another copy of message bodies. Acknowledged
receipts remain for idempotent retries and diagnostics; project/agent deletion removes
their records through foreign-key cascades. Existing inbox cursors are preserved on
upgrade; messages already consumed by the old version cannot retroactively be redelivered.

`inbox_receipt_totals` keeps each identity's confirmed-message count and latest ACK
timestamp. The first successful ACK updates these values in the same transaction as
the receipt and cursor; duplicate ACKs do not increment them. Status updates read this
single summary row and the pending batch, not the entire acknowledged ledger. The
latest timestamp remains the maximum even if the wall clock moves backward.

On the first upgrade, summary-table creation and backfill from acknowledged receipts
commit together. Pending batches are excluded. A failed migration rolls back and can
retry; subsequent restarts do not reaggregate history. Stop the old server before
upgrading: older server binaries do not maintain these counters and must not write to
the upgraded database. Receipt IDs/history are retained, and summaries also follow
agent/project deletion via foreign-key cascades.

Tests use temporary SQLite databases, dropped HTTP responses and real local stdio MCP
clients. No provider, model session or real user inbox is needed for those tests.
