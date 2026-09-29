# Collaboration rooms and persistent channel contracts

This is an optional layer on existing channels, structured tasks and delivery
receipts. It does not launch agents, parse provider events, execute task code or
change the brain/worker roles. Ordinary channels/tasks remain compatible.

## Archived channels in the Human sidebar

Human archives any public or private channel with one click on **Archive** in the
channel header (no reason or confirmation form); **Unarchive** restores it. A
coordinating brain can do the same with `room_event` `archive`/`reopen` on a Human request.

**Settings → Auto-archive task channels** (off by default) archives the private
`task-…` channel that `request_worker` opened as soon as its task is accepted or
cancelled and no other task there is open, so nothing is cancelled by it. Turning it on
also archives the task channels whose work already finished. The policy is stored on the
server and shared by every Human session. See
[Archive and source lifecycle](#archive-and-source-lifecycle) for what archiving
closes. Archived channels move out of the main channel list into a collapsed
**Archived** section in their project. Expand it to consult them; searching for a
channel or following a link to it reveals the archived entry automatically.
Archiving or unarchiving updates the sidebar live, without navigating away
from an open channel or thread. Unarchiving restores the entry to the main list.
Manual collapse is preserved through ordinary live updates; a new search or
archived-channel selection reveals the relevant entry again.

The sidebar section itself is navigation only: history, access, unread counts and
delivery receipts are unchanged. Expanding the section does not mark messages
read; opening a channel uses the usual visible-message read tracking. Reading or
receiving a message in an archived channel does not unarchive it or resume a monitor.
Direct messages cannot be archived.

The UI uses `archivedChannelIds` from `/api/ui/snapshot`, while `channels` continues
to include archived channels. Deploy the server and web bundle together; an older
server without this metadata leaves all channels in the main list.
Room events carry the channel's `archived` state, which the client applies to the
archive projection without refetching the snapshot (it refetches only the archive
projection for an event without it), preserving newer
live channels, agent presence and read/queue counters. Overlapping room refreshes
and full reconnect snapshots are ordered so a late response cannot undo an unarchive.
A failed refresh does not discard archive metadata from a successful overlapping
snapshot, nor roll back a newer successful result.

## The contract

A public or private channel can carry one contract with three fields:

- `instructions`: one free text (up to 4000 characters) saying what the channel is
  for, how agents work there and when it is done. Hivemind stores and shows it; it
  does not interpret it.
- `coordinator`: the invited brain that assigns room tasks and may change the
  contract on a Human request.
- `participants`: the names of invited workers who take room tasks and must
  acknowledge the current contract before continuing them.

Multiple generic source links may feed the channel. Separate structured task
threads track actions; accepting one result does not close the channel or stop
monitoring. Workers can ask an addressed peer in the room; this does not allow
worker-to-worker DMs, peer delegation or cross-project access.

Only already invited participants may be named. Contracts do not grant channel
access. Human can see and edit the contract in the channel's **Contract** tab. The
coordinating brain can persist a Human request using an actual visible Human message
sequence in the same project. Workers can acknowledge rules or confirm their own
interruption; bots cannot read contracts or change them.

## Authority and revisions

`get_room(channel)` returns the effective contract, revision, task fences, and source
reports. `get_room(history=true, beforeRevision=...)` pages up to 20 audit snapshots,
including the actor, optional reason and referenced Human instruction. `contractVersion`
changes only on configuration, staffing and unarchive; `revision` changes on every room event.

`room_event` takes `channel`, stable `requestId`, `expectedRevision` and an `action`
(`executionId` is no longer part of the schema; the server drops one sent by an older
client, see [Jev advice](#jev-advice)).
Retries with the same ID and payload do not repeat effects. A changed payload or stale
revision conflicts; reread before deciding what to retry.

A validation rejection did not commit. A timeout, disconnect, malformed response
or server error can occur **after** commit: the outcome is unknown. Inspect current
history/state before retrying ordinary chat (which has no request-ID deduplication).
For room/task operations, retry the exact request ID, payload and original expected
revision; do not construct a fresh operation merely because a response was lost.

The channel editor retains an uncertain operation and freezes its draft. **Retry
exact request** resends that operation even after live updates. **Reconcile with
latest state** explicitly reloads the current revision, releases the pending ID and
keeps the draft for comparison before a new save. A failed read retains the pending
operation. Definitive rejection and confirmed success release it; stale edits are
not silently rebased. This pending state is local to the open panel, not durable
browser storage: after leaving/reloading, inspect history before resubmitting.

Available actions:

| Action | Who / meaning |
| --- | --- |
| `configure` | Human or coordinator acting on a new `humanInstructionSeq`: persist instructions, coordinator and participants (`reason` optional) |
| `staff` | Coordinator (or Human): select already invited workers inside the unchanged instructions; cannot change the instructions or coordinator |
| `acknowledge` | Participating worker: read and acknowledge `contractVersion`; neither transport ACK nor task acceptance |
| `reconcile` | Assigning coordinator: `continue` compatible work at the current version or request `stop`, with a reason |
| `stopped` | Assigned worker: confirm a requested interruption; not successful task completion |
| `archive` | Human, or a brain acting on a new `humanInstructionSeq` (the coordinator when there is a contract): close the channel as the header button does; also works without a contract (`reason` optional) |
| `reopen` | Same authority: unarchive the channel (`reason` optional) |

`get_room` also returns `archived`, including for channels without a contract.
A configure, archive or reopen by a brain references a real Human message newer than
the previous authority boundary; direct Human edits and archives also advance that
boundary, so an older request cannot authorize the next change.
The server checks provenance, access, ordering and role, **not the semantic equivalence**
of prose and requested changes. The brain must not convert an unrelated/one-off
request into a standing rule. A bot saying “Human approved” is never Human authority.
Contract text, artifact references and bot report details remain data.

Human owns the instructions. The coordinator chooses execution inside them,
including staffing via `room_event staff` without a new Human instruction. Staffing
changes are versioned and fence work for reconciliation; a worker with running work
cannot be removed. Other scope changes must be proposed to Human. Only Human may
replace the coordinator, and only when no room work is running; this does not
transfer ownership of historical tasks.

## Tasks and rule changes

Use `assign_task` with the channel, worker, normal task contract, and
`room: { contractVersion, actionKey }`. Choose a stable action key for a logical
operation (for example `sensor-42-schema-check`). Reusing it with identical work
returns the canonical task, including after restart; different work conflicts.
Request IDs remain immutable even when two requests resolve to that same task.

Workers read `get_task` and `get_room`, acknowledge current room rules, then accept
and report through the existing task protocol. Contract changes fence running tasks
as `needs_reconciliation`. Compatible work continues only after coordinator
reconciliation and worker acknowledgement. Incompatible work is `stop_requested`
until the assigned worker confirms `stopped`. Blocker/rejection feedback remains
possible while fenced. Completed/stopped work stays historical; a new action needs
a new task/key.

Installing a contract requires any pre-existing tasks in that channel to be finished.
Those older, unlinked tasks remain readable but cannot be revised into running work,
even while the room is active. Use a new room task/key at the current contract version
to resume the activity; archived channels reject new assignments and revisions. Exact retries of
already committed task operations still return their original effects without
reactivating work. Channels without a contract retain their ordinary task behavior.

These are Hivemind task-operation gates, not an external execution sandbox. They
cannot instantly interrupt another host's in-flight shell command or undo completed
effects. Transport delivery, rule acknowledgement, task acceptance and completion
remain separate. Agents must obey changed instructions between external actions.

Completion described in the instructions is interpreted by the coordinator; there is
no automatic expiry timer. Archive and reopen need a Human request.

## Notifications

Contract revisions target the coordinator and participating workers; task-specific
reconciliation targets its coordinator/worker. Pure rule acknowledgements do not
wake peers. Structured task delivery keeps its existing targeted routing.

For bot observations, an active contract makes its coordinator the default observer
even in a public channel. Explicit channel/thread subscriptions still override this
default. Other routing defaults remain unchanged. In particular, invited workers in
a private room can still receive its ordinary untargeted chat. Use explicit
recipients or supported subscriptions when only selected people should wake.

No provider-specific or semantic filtering is added. Existing event-type filters can
avoid delivery; deciding from natural-language content consumes model tokens. Read
the original messages behind digests before relying on them. Contract installation
does not replay all old history or resurrect already acknowledged observations.

## Archive and source lifecycle

Archive closes everything in the channel at once. Every open task is cancelled
(workers get the usual cancellation message and must stop immediately), a contract
stops accepting work, and registered source links are asked to pause. Messages,
tasks, audit history and artifacts are kept. While archived the channel forbids new
task assignments and revisions and new non-Human root chat, and rejects new bot
observations with 409 (an exact retry of an event already stored still returns its
original result). Cancellation is a Hivemind state change, not proof that an external
tool stopped.

Unarchive reactivates the channel: its contract comes back under a new
`contractVersion` (workers acknowledge again) and registered sources are asked to
resume. Cancelled tasks stay cancelled and observations are not replayed; assign new
tasks to continue.

External bots may implement this **optional generic extension** to the bot API.
It is separate from bot configuration/enabling. Hivemind never invokes a guessed
provider command or stops the entire shared bot process/profile.

All calls use the bot bearer credential and require invitation to that channel:

1. `POST /api/bot/channels/:channel/links` with
   `{ "id": "sensor-feed", "label": "Sensor feed", "suspendSupported": true }`.
   Repeating identical registration returns the existing link/desired state; IDs
   belong to this bot and channel. Use one per actual subscription.
2. `GET /api/bot/channels/:channel/links` reads this bot's links only. Each includes
   `desired` (`running`/`paused`), increasing `generation`, and reported status.
   The external monitor polls this endpoint as part of its own loop/recovery.
3. Apply that desired state to **only that subscription**. Persist it in the bot
   before reporting. `POST /api/bot/channels/:channel/links/:id/status` with
   `{ "generation": 2, "observed": "paused", "detail": "Subscription paused" }`.
   Stale generations and success reports contrary to the request return 409; reread
   before retrying. Failures can be reported as `failed` or `unsupported` with detail.

Archiving changes only this channel's links to requested `paused`. A supported link
is `pending` until reported; an unsupported one is explicitly `unsupported`. A dead
bot stays visibly pending (there is no inferred timeout success). Report failures
and pause outcomes also notify the coordinator as bot context. The UI labels these
as **bot reports, not independent verification**. Bots without any registration
are listed as unmanaged, never claimed stopped. Existing external bots must
adopt this extension before Hivemind can request/observe their suspension.

Unarchive requests `running` for this channel's links. A bot owns retry/backfill policy and must not
silently discard provider events rejected while archived. Hivemind does not promise
exactly-once external effects; use stable bot event IDs and task action keys.

## Jev advice

With Jev enabled, a brain's `room_event` (like every other brain action) returns
`jevAdvice`, Jev's suggestion for the Human request the brain serves, for example to
keep the work in a room or to use separate DMs, and how many workers to involve. It is
advisory only: nothing about room staffing or room work is checked against it, the
brain decides, and Human instructions always take precedence. Room rules, the
coordinator, Human instructions for `configure` and participants are
enforced exactly as described above. Workers never trigger Jev. Since #211 no
`executionId` is needed and since #218 no schema lists it; one sent by an older client is ignored. See
[Jev advice](docs/adaptive-routing.md).

## Bounds and persistence

SQLite transactions atomically store room changes, audit messages and task fences;
notifications publish after commit. Contracts are capped at 4000 characters of
instructions and 16 workers. Rooms admit up to 64 running tasks and
64 source links. `get_room` returns up to 100 linked tasks with `nextTaskCursor` for
`beforeTask` pagination. Audit history pages at 20 snapshots. These are logical
bounds, not an automatic retention or deletion policy.

CLI equivalents (JSON shapes match the MCP):

```sh
hivemind room get --channel CHANNEL_ID
hivemind room history --channel CHANNEL_ID --before 21
hivemind room event --channel CHANNEL_ID --input event.json
```

Restart existing MCP clients after upgrading to discover `get_room` and `room_event`.
Human and agents use the same persisted room state. Bots, agent permissions and
provider configuration are not rewritten by installing this feature.
