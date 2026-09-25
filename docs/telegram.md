# Telegram bridge

Telegram is an optional second Human client. One forum topic per hive channel. Live only (no history backfill). Long poll, no webhook.

## Setup

1. BotFather: create a bot. Turn **Group Privacy off** so the bot sees topic messages, not only commands.
2. Supergroup with Topics on. Add the bot as admin with **post** and **Manage Topics**. Without Manage Topics, new channels/DMs fail with `not enough rights to create a topic` and stay in the outbound queue.
3. In the Human UI, open **Settings → Telegram** and paste the bot token, your numeric user id, and each project's forum `groupChatId`. Saving writes `telegram.json` next to the hive db and reloads the bridge. You can still edit the file by hand:

```json
{
  "botToken": "PUT_BOT_TOKEN_HERE",
  "allowUserIds": [123456789],
  "projects": {
    "your-project": { "groupChatId": -1000000000000 }
  }
}
```

One forum group per project. Same bot, one long poll. `chat.id` selects the project. Map each group under `projects`; a file that only has a top-level `groupChatId` is ignored. An unmapped chat is ignored. `allowUserIds` is write access only. Anyone in a group can read every topic in that group (including DMs). The UI reloads the bridge on save; a hand edit of the file still needs a serve restart.

`#general` of a project uses that group's General topic (thread 1). Other channels and DMs create topics in that same group. Hive `system` / `control` messages are not mirrored. Inbound posts are Human, with a `[Firstname]` prefix. Files and the six reactions sync both ways. Outbound is paced (~1 msg/s), bounded, and retries `429` per group so one chat does not stall the others.

Hive bodies may be up to 20,000 characters, above Telegram's 4,096-character message limit. A body that fits one Telegram message is mirrored as `Author` + newline + body, as before. A longer body is mirrored in full as numbered parts `Author (i/n)`, each at most 4,096 UTF-16 units, split at a line break or space where possible and never inside a surrogate pair. Parts are sent strictly in order; each is checkpointed before the next, so a retry resumes at the first unsent part without duplicating earlier ones. Replies and reactions on any part map to the original hive message. Inbound Telegram text (at most 4,096 characters) always fits a hive body, so the `[Firstname]` prefix no longer clips it.

Human messages from Telegram addressed to a brain go through the same adaptive routing (Jev) policy as the web UI; see [adaptive orchestration routing](adaptive-routing.md).

Do not give workers their own bot. Do not commit `telegram.json` or print the token.

When the bridge needs attention, the **Settings → Telegram** entry shows **Needs attention** with the number of outbound failures, quarantined and retrying items.

## Delivery recovery

Each queued mirror and confirmed part is bound to the original bot credential namespace (or verified bot ID when available) and chat. Changing credentials without a verified bot identity is deliberately conservative: old jobs require reconciliation. A retry never silently sends historical content to a different group. Legacy pending/part records without provable destination ownership are retained as failures instead of being redirected or blindly resent.

Human can inspect `GET /api/ui/telegram/failures`, then explicitly `POST /api/ui/telegram/failures/:id/retry` or `POST /api/ui/telegram/failures/:id/discard`. Retry returns 409 if the current destination differs, is unknown, or the outbox is full. Successful retry queues and updates its audit record atomically and wakes an idle dispatcher. A destination change requires a new, deliberate send of the original Hive message rather than a retry. Known successful parts are not resent after a restart; a lost Telegram response remains an inherently ambiguous outcome.

The failure diagnostic ledger retains at most 1,000 rows for at most 30 days, prioritizing unresolved failures. Older/overflow diagnostics are aggregated into the visible `diagnosticsPruned` counter; their original Hive messages remain. Discard/retry does not erase the audit record before retention. Message-part receipts follow retained Hive messages and are removed with their project. The UI receives live failure-health events; these events report transport health, not completion of an agent task.

Telegram 429 handling respects the full advertised retry deadline for polling and inbound API calls as well as outbound jobs. Outbound chat-specific cooldowns do not occupy the dispatcher: other eligible chats can progress, and an owned timer wakes the queue at the earliest deadline even without new traffic. Confirmed multipart checkpoints from the outbox layer are preserved across 429 retries. Cooldown timers and waits are cancelled/drained on shutdown. A 429 does not by itself prove whether Telegram applied a bot-wide or chat-specific quota; polling and each affected chat keep their own observed deadline rather than assuming an unrestricted quota elsewhere.

## Configuration and bot identity transitions

The served Human settings endpoint validates prospective routes and verifies the bot with `getMe` before touching a running bridge. It then drains the old generation and atomically publishes a private configuration file. Failed validation leaves the old bridge/configuration intact; failed file publication restarts the old configuration. Messages created during draining remain queued with the **old** audience, and a changed audience moves them to visible diagnostics rather than redirecting them.

Polling cursors, seen updates, held input, topic mappings and message mappings are namespaced by bot identity. First upgrade assigns legacy records once to the configuration active at that upgrade; it cannot reconstruct identities for historic manual configuration changes. Verified identities retain their namespace across credential rotation. Hand-edited credentials without a matching verification fingerprint use a separate conservative credential namespace until reconfigured through the served UI. Old namespaces are retained for recovery, not replayed under a different bot. CLI/offline config editing must be performed while the server is stopped.

Held input also records its project. Reassigning an existing group to another project never flushes old held input into the new project. Legacy holds with unknown project provenance are retained but are not automatically replayed.

## Inbound recovery and limits

Polling validates both HTTP and Telegram API success. Transient polling failures use exponential jittered backoff capped at 30 seconds; invalid credentials cool down for 30 seconds. A 429 always observes the advertised deadline, including `Retry-After`. An immediate empty success is paced to prevent a broken proxy from spinning. These are observed per-poll/per-chat limits, not a guarantee that a different chat is exempt from a provider-wide quota.

Failed input is persisted **before** advancing the bot's cursor. The failure record, seen marker and monotonic cursor commit in one SQLite transaction. Independent local retry scheduling allows later updates, including another project's messages, to continue. Retry deadlines survive restart; transient ingestion has at most five automatic attempts, while malformed/unsupported input goes directly to quarantine. A successful inbound message and its Telegram correlation receipt share the existing message/attachment transaction, and events are emitted only after commit. Duplicate updates and replies to mirrored roots, replies or attachment parts resolve against the original project/channel. Missing original context produces a visible `[Original reply unavailable]` fallback rather than a foreign thread.

Human can inspect `GET /api/ui/telegram/quarantine`, then use `POST /api/ui/telegram/quarantine/:id/retry` or `POST /api/ui/telegram/quarantine/:id/discard` with the returned diagnostic ID. Explicit retry validates the original bot, chat and project identity, resets the attempt budget, and wakes the idle retry dispatcher. A route invalidated by a remap cannot be revived by remapping it back. Legacy diagnostics without provable scope remain visible but cannot be replayed automatically. No raw payload or bot token is returned by the diagnostic list.

Inbound retries are capped at 200 globally. The separate inbound diagnostic ledger retains at most 1,000 entries for 30 days, prioritizing active retries and unresolved quarantine; payloads over 64 KiB are not retained for replay. Pruning increments `inboundDiagnosticsPruned`, and oversized input is explicitly non-replayable. These limits apply to failure diagnostics; ordinary message history, correlation receipts and legacy unresolved forum-topic holds follow their existing persistence policies. Removing a project also removes its scoped Telegram diagnostics.

Outbound scheduling is round-robin across eligible chats while preserving each chat's FIFO order. Cooldown deadlines and failure attempts survive restart. Ordinary failures stop after five attempts, repeated 429s after twenty, and a job's automatic retry window is at most 24 hours after its first failure; exhaustion is visible in the failure ledger. A newer desired reaction queued during an in-flight request is not cleared with the old revision. Completed multipart parts are never intentionally resent to the same destination.

Live `telegram-health` WebSocket events carry a persisted revision shared by inbound and outbound status. The UI merges snapshots/events by revision so an old HTTP response cannot erase a newer failure or recovery. Unchanged status is not rebroadcast on every poll; the latest successful-poll timestamp remains available in the snapshot. These diagnostics do not replace the Human authorization boundary and do not imply that an agent task has completed.

Configuration publication is the authoritative restart boundary. The old bridge is drained first. An accepted poll batch interrupted by draining transfers its entire unfinished remainder to durable retries atomically, retaining the original project identities; failure to persist that handoff blocks publication of the new configuration. Startup reconciles stale jobs/mappings against the published configuration before any new polling/sending begins. A crash during reconciliation can resume that idempotent reconciliation on restart. No distributed exactly-once claim is made: Telegram may accept a request whose response is lost, or the process may exit before saving that external response. Confirmed local checkpoints avoid known duplicates, but that external ambiguity requires Human judgment.

The regression suite uses fake Telegram responses, controlled promises and fake timers, plus local SQLite/HTTP/WebSocket boundaries. It does not contact a live bot or verify Telegram's production quotas. Run `npm run check` and `npm run test:coverage`; the standard CI additionally covers Node 22.13.0/24 on macOS, package smoke tests and security checks.

See [Extensibility security](../EXTENSIBILITY-SECURITY.md) for bot ingress limits,
credential recovery, plugin execution boundaries, and the trusted-local deployment model.
