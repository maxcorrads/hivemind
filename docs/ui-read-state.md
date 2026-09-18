# UI mentions and read receipts

Fresh integration from main `738c1dd2cf3b89d7da35d6f8528c1a31bf83149f`,
replacing the implementation approach in #51 / #8. Coordinated with #25;
the general conversation/reaction snapshot-reconciliation work remains #52/#11.

## Read contract

- Fetching channel/thread history, fetching a snapshot and sending a message
  do not acknowledge anyone else's messages.
- After React commits a page belonging to the current selection, the UI sends
  `POST /api/ui/read` with `{channelId, threadId, messageSeqs}`. A receipt means
  that the message belongs to that mounted page, not that eye tracking proved
  the user read every word. Search-hidden channel panes are not acknowledged.
- The server validates every sequence against the selected channel/thread and
  visible channel access. Each receipt contains at most 200 positive safe
  integer sequences. Mixed scopes fail atomically; duplicate retries are safe.
- Roots shown in a channel do not acknowledge their unopened replies. Opening
  a thread acknowledges only its displayed page. Later replies and unrequested
  pages remain unread. "Load more replies" traverses the forward cursors added
  by #77, preserving the root and already loaded replies.
- The old explicit `{channelId, seq}` read-through command remains supported;
  it is never sent automatically by the new UI.

## Persistence and queries

`message_reads` supplements the existing `reads` table. Legacy read-through
semantics are preserved, including replies read before this upgrade; there is
no destructive reinterpretation or historical-thread resurrection. Exact
receipts survive restart and cascade on message/agent deletion, including
project deletion. This targets upgrades from main, not deployment of unmerged
experimental schemas.

Inbox queries apply visibility, project, exact mention identity, unread state
and the exclusive sequence cursor **before** LIMIT. Counts use the same unread
predicate, including thread replies; the project badges are not derived from
one globally limited page. Marking all mentions seen has no 400-row cap and
does not acknowledge unrelated ordinary messages or another project.

## Client ordering and bounded scheduling

Read snapshots expose an instance ID, persistent read revision and message
high-water sequence. The client rejects older read snapshots, responses older
than an observed live message, and callbacks from an invalidated connection.
These fields do not version general conversation bodies, reactions or rosters.

Each rendered pane owns one serial receipt queue, one pending rendered window
and at most one scheduled callback. Bursts replace pending work; receipts drain
in batches of 200. Timers and requests are cancelled on navigation/disposal.
Read-only refresh has one in-flight request and one dirty/trailing refresh,
not a request for every presence event. Failed writes surface an error and can
retry on a subsequent rendered update or reconnect, without an infinite loop.

Navigation guards protect initial loads, pagination and thread mutations.
Sending or changing thread status no longer overwrites the pane with another
unconditional first-page HTTP fetch. Inbox pages are project-scoped and reject
obsolete navigation/read versions. A fresh inbox read revision reloads its
first page; older pages remain reachable via pagination.

## Executed and required validation

- 24 focused Node 22.13.0 tests pass: 13 SQLite/HTTP cases and 11 deterministic
  read-fence/queue/request ownership cases. No sleep-based race assertions.
- Focused coverage: server read-state and shared read-client both 100% lines
  and functions; branches 96.00% and 93.83%, respectively.
- Local lint, server/web typechecks and production build pass. Full local
  `npm run check`: 122/123 tests pass; the existing macOS roster-paste fixture
  requires `zsh`, absent in this Linux container. No test or gate is weakened.
- `scripts/verify-ui-read-state.py` contains mounted Playwright acceptance for
  thread transitions/reconnect, project pagination, delayed navigation/thread
  loads, stale receipt responses and forward thread pagination. It runs after `npm run build`, against a
  temporary real Hive/server and an installed Chromium browser. Requires
  Playwright Python; set `NODE` and `CHROMIUM` to executable paths as needed.
  Its execution status and the final required macOS CI must be checked on the
  PR's actual head. Local Chromium navigation is policy-blocked in this environment.

## Remaining integration boundary

#25 still owns installing/wiring the canonical browser suite into CI and the
complete #52/#11 merge/replay policy for HTTP snapshots overtaken by live
messages/reactions. Read receipts deliberately never acknowledge a message
merely because a newer sequence exists on the server. Do not interpret this
slice as a durable WebSocket replay protocol or proof of bounded total DOM/
history memory. #80 handles the separate safe presence/transport slice of #63.
