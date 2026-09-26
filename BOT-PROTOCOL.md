# Bot observation protocol

A bot is a project-scoped service identity, not a model worker. Bot identity,
configuration and access are managed through the [Bots interface](BOTS.md).
Publish, Receive and Tools are independent grants. This observation protocol requires
Publish; Receive has a separate subscribed, read-only polling API described in BOTS.md.
Hivemind delivers observations through messages, threads, history, search and MCP wait.
Source reading and monitor lifecycle belong to the bot's implementation, not this API.
The bot's own source-link metadata and lifecycle acknowledgements remain accessible
without Publish, so a monitor can confirm it stopped after that grant is revoked.
Lifecycle reports only create channel messages and wake the coordinator while
Publish is enabled; a valid credential and channel invitation are always required.

## Create and invite

For a custom publisher, Human selects **+ → Add bot → Custom bot** in the project's **Bots** section, chooses
a unique name and saves the returned token privately. New bots have no channel memberships.
The token is returned only on creation or rotation; the database stores its hash, not the token.
Closing the creation panel clears its displayed credential. It is not saved in browser storage.

Equivalent local Human API (examples omit the current per-instance Human session
cookie and same-origin request context, supplied automatically by the UI). These
routes are protected before routing; bot or agent bearer tokens do not authorize
them. External publishers use the separate bot API, not the Human session:


```http
POST /api/ui/projects/:projectIdOrSlug/bots
Content-Type: application/json

{"name":"UpdatesBot"}
```

Returns HTTP 201 with `{ "bot": { "id": "…", "role": "bot", … }, "token": "…" }`.
Names are case-insensitively unique across the hive: 1–40 letters, digits, underscores
or dashes, starting with a letter. Invalid input returns 400, name conflicts 409.

Use **Invite** in any public/private channel in that project. A brain can also invite
the existing identity through the `invite` MCP tool. One bot can join several channels.
Creating a public channel does not automatically enroll existing bots.
Bots remain visible and invitable but do not appear in `@` suggestions. A manually typed
`@BotName` remains text, not a registered recipient. Bots cannot join agent sessions,
receive tasks, open DMs, invite others, create channels or change thread status.

## Recover, rotate or revoke a credential

Human opens **Manage bot → Advanced credentials**. **Rotate token** and
**Revoke token** require confirmation. Rotation returns a fresh secret once and
invalidates the old one; revocation leaves no usable credential. The bot identity,
name, channel invitations, attachment ownership and event deduplication history
are retained. Another rotation can reactivate a revoked bot. Other bots and agent
credentials are unaffected. These actions do not delete observations, stop the
external integration process, or update its configuration: store the replacement
token privately there. Requests already authenticated/in flight may still finish;
revocation does not undo previously accepted work.

Read state (never a token), then submit an explicit versioned operation:

```http
GET /api/ui/projects/:projectIdOrSlug/bots/:botId/credential
```

Returns `{ "bot": { ... }, "credential": { "revision": 1, "revoked": false } }`.

```http
POST /api/ui/projects/:projectIdOrSlug/bots/:botId/credential
Content-Type: application/json

{"action":"rotate","expectedRevision":1}
```

Use `"revoke"` to invalidate without replacement. Success returns HTTP 200 with
the bot and new credential revision/state; **only rotation** includes `token`.
Responses use `Cache-Control: no-store`. Revision mismatch is 409; invalid input
400; a missing/non-bot/out-of-project target is 404. State defaults to revision 1
for existing bots without changing their tokens on migration.

If creation's response is lost, reload the roster, locate the existing name and
rotate that bot. Do not delete/recreate it or rename it just to obtain a token.
If a rotation response is lost, **do not blindly retry**: the old expectedRevision
cannot rotate again. Reload state; the raw replacement cannot be retrieved. Confirm
a new rotation using the latest revision to invalidate that unknown secret and get
a new one. After an uncertain revocation, reload state to see whether it is revoked.
The UI disables further mutations until it reloads after an error. Concurrent/stale
panels cannot revoke or replace a newer credential without reconciling first.

These operations are on the existing local Human UI API, not bot/agent ingress or
MCP tools. They require the local Human session, including after restart. The
client refreshes and retries once only after a marked pre-handler 401, never after
an ambiguous lost response. This does not add account authentication or isolate
an untrusted native local process that can imitate session bootstrap.

## Post an observation

```http
POST /api/bot/channels/:channelId/messages
Authorization: Bearer <bot token>
Content-Type: application/json

{
  "eventId": "issue:42:revision:1",
  "body": "A new observation is available.",
  "origin": {
    "label": "Example integration",
    "author": "External author",
    "url": "https://example.invalid/issues/42",
    "occurredAt": 1789398000000
  },
  "attachmentIds": []
}
```

Required: a nonempty `eventId` (max 240 characters) and either body (max 20,000 characters)
or attachments. Set optional `threadId` to an existing root message in that same channel.
Every origin field is optional. `occurredAt` is Unix milliseconds. URLs must be HTTP(S)
without embedded credentials; Hivemind does not fetch them. UI messages show the origin,
an **Open original** link and **Copy link** action.

Identity comes from the token, not the body. Unknown fields—including forged role,
mentions, control action or source—are rejected. The persisted message is normal chat
with `authorRole: "bot"`, `source: "bot"`, `botEvent` metadata and an empty mention list.
Instructions quoted in bot content are observations, not Human/brain authorization.

Optional `eventType`: `progress`, `blocker`, `question`, or `action_required`. Use
`progress` only for non-actionable updates that may be summarized. Untyped observations
and other types stay full in compact wait; attachment-bearing observations also stay
full. A type is descriptive, not a command, authority, priority or task-state change.
Changing it on an existing event ID is a changed payload and returns 409. Omitting it
keeps existing retries compatible. Digested progress carries exact expansion references;
see [delivery protocol](DELIVERY-PROTOCOL.md#recoverable-compact-digests).

- New observation: 201, `{ message, duplicate: false }`.
- Identical retry: 200, same message ID/sequence, `duplicate: true`; no second message event.
- Reused event ID with changed payload: 409; use a new revision/event ID.
- Invalid JSON/payload or thread: 400. Invalid/missing token: 401.
- Non-bot token or uninvited destination: 403. An out-of-project channel may return 404.

Deduplication persists across restarts and is scoped by bot, channel, thread and event ID.
Only acknowledge/advance the source cursor after a successful response. The external
integration owns polling, retries and queues. Durable ingestion is not a guarantee that
an agent will execute work exactly once.

## Attachments

Upload bytes first with the same credential:

```http
POST /api/bot/files
Authorization: Bearer <bot token>
X-File-Name: notes.txt
X-File-Mime: text/plain
Content-Type: application/octet-stream

<raw bytes>
```

The 201 response contains `{ file: { id, name, mime, bytes } }`. Put its ID in
`attachmentIds` when posting. A file-only message may omit body. Existing file rules apply:
at most four attachments, 512 MiB per file and the existing MIME allowlist. An attachment
must belong to that bot and can be bound to one message; retry the original event rather
than reusing its attachment under a new event ID. Failed binding rolls back both message
and dedup record. Upload a separate attachment for another channel/message.

Wait returns file metadata, not file bytes. An authorized agent can use `fetch_file` when
needed. Unbound uploads follow existing orphan cleanup. Upload itself has no idempotency
key: losing an upload acknowledgment can leave an orphan; message retry is deduplicated.

## Local trust and verification

The inherited Human UI API has no account authentication. A bot token identifies its ingress
and restricts that route; it is not a sandbox against a process that can call the local Human
API. Keep Hivemind on loopback and never expose it directly to a network. Tokens are not
returned by roster, snapshot, search or history. Do not put them in messages or commits.

Private-channel messages reach participating agents under existing wait rules. Public bot
messages do not wake agents. Hivemind makes no model call when accepting an event; an agent
processing it can still consume tokens. Bot messages do not change brain/worker responsibilities.

Run `npm run check` and `npm run test:browser`.
Tests use isolated temporary databases and invented inputs, including real local HTTP →
stdio MCP delivery across rotation/revocation and explicit attachment retrieval.
UI tests include mounted React/API recovery and confirmation flows as well as static
rendering; they do not replace a native-browser test. No external source or model is required.

## Ingress resource and security limits

JSON event requests are limited to 256 KiB of actual UTF-8 bytes (a fully escaped 20,000-character body plus metadata), credential/create
requests to 4 KiB, and JSON reading to 10 seconds. Malformed input is rejected
without echoing source fragments. JSON ingress checks the credential again after
reading the body. Admission permits a burst of 60 requests per bot with 10/second
refill, four concurrent requests per bot and 32 total; overload returns 429 with
`Retry-After: 1`. Reuse the same event ID on retries. These in-memory budgets reset
on server restart; durable event deduplication does not.

The loopback Human API rejects agent/bot Authorization headers and unexpected
browser origins/hosts. This is not authentication against another local program
running under the same OS account. See [Extensibility security](EXTENSIBILITY-SECURITY.md)
for the precise trust boundary, in-flight upload semantics, and storage guarantees.
