# Optional coordination: tasks and rooms

## Decision

Keep tasks and rooms separate, built on the existing message/thread/channel model.
A task owns one assignment, the worker's response, a result and the assigning
brain's review. A room owns a channel contract, its coordinator, declared workers
and lifecycle. A room is not another task board and an accepted task does not
implicitly archive its room. Ordinary messages and ordinary channels remain
usable without either protocol.

Human remains the administrator and cross-project bridge. Brains assign and
review work; workers accept, reject, report blockers and submit results. A room
contract never grants channel access. Invitations and project authorization are
checked independently of declared participation. Human can read task state but
does not impersonate the assigning brain's review.

The shared primitive is a synchronous SQLite transaction, not a generic business
workflow engine. Task transitions, room changes and delivery receipts keep their
own validation. Publish notifications only after commit. An ACK records receipt,
not acceptance or completion. An exact committed retry returns existing state
without another message, receipt count or task transition.

## One source of truth

Room metadata on a task response is derived from the room contract, task link and
current worker acknowledgement. Do not store that projection in `task_records`.
Older prototype snapshots containing a `room` property still read correctly; the
property is discarded on the next task write. Contract-version changes fence
work until explicit reconciliation and worker acknowledgement, rather than
silently rewriting task ownership or claiming that an external process stopped.

Request IDs deduplicate exact protocol operations. Task revisions protect
concurrent updates. Room action keys identify logical work independently of an
HTTP retry. None of these makes ordinary chat idempotent: after an uncertain
send, inspect history before resending. The mounted room editor preserves an
uncertain operation's ID, payload and original revision until explicit recovery;
leaving/reloading the panel still requires inspecting history.

## Integration provenance

This integration preserves the useful implementation and tests from:

- #41 at `f5a173a33a749834ba418ec80d3d96726c874c25`;
- #43 at `4b4e8c9c49a63dc7b814442274434c176480ef3a`.

Those branches include the unmerged bot/plugin/delivery/digest/notification
stack (#36–#42). The aggregate integration includes it explicitly; it is not
represented as an isolated two-file change. The previous worker-evidence,
receipt-total/backfill, sparse/split ACK and uncertain-room-retry repairs are
retained. Current upstream CI, packaging, license and release gates take
precedence over stale branch configuration.

The integration additionally fixes rollback on the minimum supported Node
22.13.0 runtime without reading `DatabaseSync.isTransaction`, preserves embedded
NUL message bodies through the SQLite read boundary, and runs mounted JSX tests
through the normal test discovery script. It does not lower coverage thresholds.

## Validation and limits

Run `npm run check` and `npm run test:coverage`, including Node 22.13.0 and Node
24. Focused coordination coverage lives in `transaction.test.ts`,
`rooms.test.ts`, `tasks.test.ts` and the server/MCP
`coordination-contracts.test.ts` files. The inherited receipt, notification,
room-retry and UI reconciliation suites remain part of `npm test`.

The contract tests use real HTTP, SQLite, WebSocket and stdio MCP boundaries,
including reconnect, permission failures, exact retries and ordinary messages.
The existing WebSocket endpoint is the local Human/admin UI transport, not an
authenticated agent-scoped socket; these tests do not claim to solve the separate
local-session/authentication workstream.

Functional acceptance is not a model-productivity benchmark. No automatic
authorization is inferred from the meaning of Human prose. Source pause/stop
states remain requests and participant/provider reports, not independently
verified process termination. A stopped task is not successful completion, and
a finite room's summary does not complete its originating task. Browser/native
provider acceptance and general token/latency savings require separate evidence.
