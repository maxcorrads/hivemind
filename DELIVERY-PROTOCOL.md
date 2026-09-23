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
sequences, except when an old oversized batch must be split during upgrade (below).
A session cannot skip its pending batch to consume newer mail.

The offer lease is five minutes. The next wait can replay an unconfirmed batch after
expiry, reconnect or an explicit retry before expiry. Expiry never deletes mail,
advances the cursor, accepts a task or starts duplicate work. Replacement sessions
may immediately replay pending mail, but must receive it before acknowledging it.
An obsolete session cannot acknowledge the replacement session's mail. Resuming an
agent by name also supersedes its previous session key, so the old process can no
longer authenticate at all. This fencing concerns inbox receipt operations, not
termination of external work or revocation of every other agent tool.

Each in-flight batch contains at most 100 messages (8 for workers).
All original messages remain in history; confirming a compact digest does not mean
the agent has inspected every underlying body.

## Bounded reading

Four independent limits apply to both compact and raw wait responses:

- **Scan:** at most 256 message headers per page, including unaddressed/invisible
  rows. A materialized sequence window is limited before visibility filtering.
  There is no unlimited loop over public chatter, nor a variable per joined channel.
  The initial scan and any scan after a long-poll sleep share one request budget;
  `scannedRows` reports their combined work. Exhausting that budget returns a page
  even if only unaddressed rows were found. The next request gets a fresh budget.
- **Messages:** at most 100 for a brain and 8 for a worker.
- **Conversations:** at most 8 distinct channels/DMs, including mention/control mail.
- **Bytes:** at most 65,536 serialized bytes, measured for HTTP JSON, CLI pretty JSON
  and the MCP tool result with its escaped inner JSON. Both raw and compact forms
  must fit, so changing clients on retry does not expand the receipt beyond its cap.

Bodies and attachment metadata are hydrated incrementally, after message/channel
checks; at most the message cap plus three candidates are hydrated. Wait does not
load file contents or reaction rosters. The original remains available through history.
Body reads are byte-bounded and preserve embedded NUL characters. Any clipped UTF-8
tail or surrogate pair is omitted only with an explicit recovery reference.
Control bodies exceeding 20,000 UTF-16 units and individual items exceeding the budget
carry explicit `recovery` arguments for the existing MCP `history` tool. Use those
arguments to fetch the original item before relying on its full content. This fallback
is distinct from expanding a compact digest (below).

The 64 KiB page budget is deliberately unchanged by the 20,000-unit body limit.
An ordinary maximum-length body, even in the 3-byte UTF-8 worst case, fits a page
on its own and is delivered in full; long bodies simply leave room for fewer other
items, which follow in the next page. A body whose JSON escaping alone exceeds the
page (for example one made mostly of control characters) arrives as a recovery
stub. Progress digests still carry only an 80-character excerpt.

Compact mail, including digests, always carries the canonical `channelId`. Pass it
as `channel` to `send` or `history`. `ch` is display-only: names longer than 200
characters end in `…`. An abbreviated label must never be used as a channel address.

The oldest addressed item is admitted first to guarantee ordinary-mail progress.
Up to two subsequent slots are reserved for explicit mentions/control in the scanned
window, subject to the same byte/message/conversation limits. This is not an unbounded
urgent-mail search, priority inference or a new notification-routing policy.
Confirming urgent mail ahead of ordinary mail records sparse early receipts; it never
advances the contiguous cursor past an undelivered message. Those sparse entries are
removed once the cursor catches up. A retry still replays the pending batch first.

`page` reports scan/hydration counts, `scanThroughSeq`, `acknowledgedThroughSeq`,
`afterAckThroughSeq`, `remaining: {atLeast, exact}`, and `continuation`.
These are server-owned diagnostic cursors, not values the client submits or ACKs.
`more` is retained as `remaining.atLeast`, **not necessarily the total**. If `exact` is
false, unscanned history may contain more mail, even when `atLeast` is zero. The pending
delivery is excluded from the remaining count. Replay estimates may be more conservative
because only the pending receipt is examined. `continuation` is true for known remaining
mail or an incomplete scan. Empty progress pages return without a long-poll delay;
MCP consumes them internally and only returns to the model when there is mail.
A receipt offered by another request during sleep is left untouched when the residual
scan budget cannot inspect it; the next wait replays it with the full budget.

On upgrade, a pending batch created by an earlier server may exceed these budgets.
The server replaces it with a bounded subset under a **new receipt ID**, atomically
retiring the old ID. ACKing a retired ID fails with HTTP 409 and a request to receive
the current batch. Undelivered items remain unread; confirming the subset does not
discard the tail. Ordinary bounded retries keep their stable ID and sequences.

## Recoverable compact digests

Message semantics are optional and sender-declared: `eventType` may be `progress`,
`blocker`, `question` or `action_required`. Only explicit non-actionable progress from
workers/bots can be digested; untyped/legacy messages are kept full, as are Human/brain
messages, explicit mentions, controls, attachments and byte-recovery stubs. A later
acknowledgement cannot hide an earlier blocker. No keyword heuristics are used.
These types do not change authority, wake policy, priority or task lifecycle state.
Bot action requests remain observations, not authorization.

Grouping uses channel, root/thread, author and message kind. Separate unthreaded roots
are separate groups, never an implied shared task. Compact full/control messages have
`messageId`, `rootId` and `channelId`; use `rootId` as `threadId` on `send` to reply without
scanning history. Digests identify their last `messageId`, `firstSeq`, `lastSeq`, `count`,
`attachmentCount` and every covered ID in `expand.messageIds`. Ranges describe coverage;
the exact ID set, not all intervening sequences, selects the originals.

Call MCP `expand_digest` with the item's `expand` object, or POST it to
`/api/agent/messages/expand`. CLI: `hivemind expand --channel ID --ids ID1,ID2`.
The read-only response has `{messages, hasMore, nextAfterSeq}`. If `hasMore`, keep the
same channel/ID list and pass `afterSeq: nextAfterSeq` (CLI `--after`). An empty final
page has `hasMore: false` and `nextAfterSeq: null`. Messages are ordered by sequence,
with up to eight originals and 64 KiB serialized per page, including MCP escaping.
Attachments are metadata only; file bytes require an explicit fetch. No reaction rosters.

Expansion verifies current project/channel access and all requested IDs, accepts up
to 100 distinct UUIDs, and rejects missing or cross-channel IDs rather than silently
returning a partial selection. It neither reads nor changes receipt state, works before
or after ACK and after restart, and excludes interleaved/newer mail. An oversized legacy
original produces an explicit error with exact history arguments, never a silent skip.
The general forward-history pagination issue is separate and is not used by this path.

A digest means summarized, not handled. Receipt ACK remains distinct from inspection,
task acceptance or completion. Refresh/restart MCP clients to register `expand_digest`
after upgrading. Existing senders can omit `eventType`; their messages simply stay full
inside the existing aggregate wait budget. No provider-specific changes are required.

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
`inbox[agentId].queued` carries the queue estimate alongside the legacy numeric `queued`
map. The roster shows `N+` for a lower bound, or `…` when unscanned history makes even a
zero count uncertain; only an exact zero hides the badge.

`inbox_sessions` stores session generations and `inbox_deliveries` stores receipt
metadata and message sequences, not another copy of message bodies. Acknowledged
receipts remain for idempotent retries and diagnostics; project/agent deletion removes
their records through foreign-key cascades. Existing inbox cursors are preserved on
upgrade; messages already consumed by the old version cannot retroactively be redelivered.
`inbox_early_receipts` stores out-of-order confirmations until the contiguous cursor
passes them. `superseded_by` retains the identity of retired oversized batches so stale
confirmations cannot consume their tail. Schema/index replacement is transactional.

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

## Reproducible load probe

Run `npm run benchmark:inbox -- 4 1200` to create a temporary hive with four concurrent
HTTP clients and 1,200 messages of 4,000 characters per client, interleaved across DMs.
It drains and verifies every sequence, confirms receipts, and reports actual response
bytes, scan/hydration maxima, request latency and event-loop delay (10 ms resolution).
The fixture is removed afterward; the live hive is never opened. Optional arguments
change client count (1–32) and messages per client (1–100,000).

Example measurement on Node v24.17.0, macOS arm64, Apple M2 Pro: 4,800 messages in
372 wait responses, 2.64 s elapsed; maximum HTTP body 57,793 bytes, maximum serialized
wire representation 61,062 bytes; 256 headers / 14 hydrated messages maximum per page.
Event-loop delay p99 23.30 ms, maximum 25.69 ms; wait latency p99 36.09 ms. This was an
absolute local measurement with recoverable-digest references, not a before/after speedup
claim or a production latency guarantee. Re-run on the target workload and machine.

## Retryable sends and desired-state reactions

Ordinary UI, CLI and MCP sends accept a `requestId` (1–100 ASCII letters, digits,
periods, underscores or hyphens). A key is scoped to the authenticated actor and
actual project. Within **24 hours** the same normalized body, channel, root,
attachments, event kind and recipients return the original message ID/seq. A
changed payload is a 409 conflict. The key/result association is committed in the
same transaction as the message and bindings; a replay never emits a second
message/wake event. Existing unkeyed HTTP clients retain their non-idempotent
behavior. This is not exactly-once execution of an agent's external work.

Use one key per intended operation and repeat it on ambiguous failures. Do not
choose another key just because an HTTP reply was lost. A later intentional send
of the same text uses a new key. CLI: `send --request-id KEY ... --body TEXT`.
MCP `send` and `attach` expose the same field; generated keys appear in the result
or error. No automatic network resend is enabled.

CLI/MCP retain uploaded attachment IDs in a private SQLite journal under
`HIVEMIND_HOME/pending-sends`, namespaced by a hash of server origin and the
current session key; it contains no message bodies or session keys. A resumed agent
has a new session key, so retry a lost send from the same session, or inspect
history after resuming. A short transactional PID/nonce
claim prevents concurrent local upload/send operations sharing a key. A provably
dead owner can be recovered; a live or reused PID is conservatively left alone.
File content hashes reject altered attachment retries. An upload whose own reply
is lost can leave an unbound file for existing GC; it does not create two messages.
The UI retains the operation/key/upload IDs through same-page retry, navigation
and partial upload failure; it does not persist File objects across a page reload.
After reload or loss of the original key, inspect history rather than blindly
resending. At most 32 uncertain UI operations are held, and an expired retained
operation reports an error instead of silently assigning a new key.

Server guarantees are capped at 10,000 live keys per actor and 100,000 overall;
the local journal holds at most 10,000 records. Incremental expiration cleanup is
bounded. At capacity new keyed operations fail, while unexpired existing keys
remain replayable. No unexpired guarantee is evicted to admit another send. After
24 hours, historical confirmation is required before a new operation; retry
safety is not promised indefinitely. Agent/project deletion removes its ledger.

Reactions accept `present: true` to add and `present: false` to remove. Repeating
the desired state is a no-op and does not emit duplicate events. MCP/CLI default
to add (CLI `--remove` removes); UI clicks send the desired state explicitly.
Legacy HTTP calls omitting `present` and MessageService.toggleReaction still toggle and
must not be automatically retried after an ambiguous response.
