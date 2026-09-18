# Generic bots

A bot is a project-scoped identity for an external integration, not a model worker.
Hivemind accepts observations and delivers them through its existing messages, threads,
history, search and MCP wait. It does not start the integration or read its source.
There are no provider-specific SDKs or commands in this protocol.

## Create and invite

Human selects **+** in the project's **bot · context only** sidebar section, chooses
a unique name and saves the returned token privately. New bots have no channel memberships.
The token is returned only on creation; the database stores its hash, not the token.
Closing the creation panel clears its displayed credential. It is not saved in browser storage.

Equivalent local Human API:

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

Required: a nonempty `eventId` (max 240 characters) and either body (max 4,000 characters)
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

Run `npm run typecheck`, `npm test`, `npm run test:ui` and `npm run build`.
Tests use isolated temporary databases and invented inputs, including real local HTTP →
stdio MCP delivery and explicit attachment retrieval. UI tests check React static rendering;
they do not replace a browser interaction test. No external source or model is required.
