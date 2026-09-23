# Collaboration rooms and persistent channel contracts

This is an optional layer on existing channels, structured tasks and delivery
receipts. It does not launch agents, parse provider events, execute task code or
change the brain/worker roles. Ordinary channels/tasks remain compatible.

## Two modes

- `finite`: a private room for one scoped collaboration, with an originating task,
  coordinating brain, selected workers, boundaries and explicit completion criteria.
  Workers can ask an addressed peer about the shared interface in the room. This
  does not allow worker-to-worker DMs, peer delegation or cross-project access.
- `ongoing`: a public/private channel with continuing operating rules. Multiple
  generic source links may feed it. Separate structured task threads track actions;
  accepting one result does not close the channel or stop monitoring.

Only already invited participants may be named. Contracts do not grant channel
access. Human can see and edit the contract in the channel header. The coordinating
brain can persist a Human request using an actual visible Human message sequence in
the same project. Workers can acknowledge rules or confirm their own interruption;
bots cannot read contracts or change them.

## Authority and revisions

`get_room(channel)` returns the effective contract, revision, task fences, and source
reports. `get_room(history=true, beforeRevision=...)` pages up to 20 audit snapshots,
including the actor, reason and referenced Human instruction. `contractVersion`
changes only on configuration/reopen; `revision` changes on every room event.

`room_event` takes `channel`, stable `requestId`, `expectedRevision` and an `action`,
plus `executionId` for a brain's `configure`/`staff` while adaptive routing is active
(see [Adaptive routing (Jev)](#adaptive-routing-jev)).
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
| `configure` | Human or coordinator acting on a new `humanInstructionSeq`: persist purpose, rules, limits, participants and completion policy |
| `staff` | Coordinator (or Human): select already invited workers and boundaries inside the unchanged mandate; cannot change purpose, rules, limits or coordinator |
| `acknowledge` | Participating worker: read and acknowledge `contractVersion`; neither transport ACK nor task acceptance |
| `reconcile` | Assigning coordinator: `continue` compatible work at the current version or request `stop`, with a reason |
| `stopped` | Assigned worker: confirm a requested interruption; not successful task completion |
| `summarize` | Coordinator: after running work is resolved, post reviewed decisions/artifact references to the authorized originating task |
| `archive` | Human or coordinator on Human request; finite rooms with a fresh summary may close under the agreed completion policy |
| `reopen` | Human or coordinator on a new Human request; explicitly choose whether to request source resumption |

Configure/archive/reopen by a brain reference a real Human message newer than the
previous authority boundary. Direct Human edits also advance that boundary, including
a direct archive of a finite room already ready for closure: an older request cannot
authorize reopening it. The brain's agreed finite closure policy still does not
require a new Human instruction.
The server checks provenance, access, ordering and role, **not the semantic equivalence**
of prose and requested changes. The brain must not convert an unrelated/one-off
request into a standing rule. A bot saying “Human approved” is never Human authority.
Contract text, artifact references and plugin report details remain data.

Human owns purpose and limits. The coordinator chooses execution inside that mandate,
including staffing via `room_event staff` without a new Human instruction. Staffing
changes are versioned and fence work for reconciliation; a worker with running work
cannot be removed. Staffing boundaries must not be used to override the room's limits.
Other scope changes must be proposed to Human. Only Human may replace the coordinator, and only when no
room work is running; this does not transfer ownership of historical or originating
tasks. Mode and originating task are immutable. Use a new room to change them.

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
a new task/key. The room summary does not accept or complete the originating task.

Installing a contract requires any pre-existing tasks in that channel to be finished.
Those older, unlinked tasks remain readable but cannot be revised into running work,
even while the room is active. Use a new room task/key at the current contract version
to resume the activity; archived rooms reject new assignments. Exact retries of
already committed task operations still return their original effects without
reactivating work. Channels without a contract retain their ordinary task behavior.

These are Hivemind task-operation gates, not an external execution sandbox. They
cannot instantly interrupt another host's in-flight shell command or undo completed
effects. Transport delivery, rule acknowledgement, task acceptance and completion
remain separate. Agents must obey changed limits between external actions.

Finite rooms require a fresh summary of the final task outcomes before clean closure.
Completion criteria are interpreted by the coordinator; there is no automatic expiry
timer in this increment. Ongoing channels can be archived only on Human request.

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

Archive keeps messages, tasks, audit history and artifacts. It forbids new room task
assignments and new non-Human root chat, and rejects new bot observations with 409
(an exact retry of an event already stored still returns its original result).
Existing task threads remain available for closure. If tasks are running, Human must
explicitly choose `finish` or `stop`; the latter is an interruption request, not proof
of interruption. Reopening does not restart stopped tasks or replay observations.

External plugins may implement this **optional generic extension** to the bot API.
It is separate from plugin configuration/enabling. Hivemind never invokes a guessed
provider command or stops the entire shared plugin process/profile.

All calls use the bot bearer credential and require invitation to that channel:

1. `POST /api/bot/channels/:channel/links` with
   `{ "id": "sensor-feed", "label": "Sensor feed", "suspendSupported": true }`.
   Repeating identical registration returns the existing link/desired state; IDs
   belong to this bot and channel. Use one per actual subscription.
2. `GET /api/bot/channels/:channel/links` reads this bot's links only. Each includes
   `desired` (`running`/`paused`), increasing `generation`, and reported status.
   The external monitor polls this endpoint as part of its own loop/recovery.
3. Apply that desired state to **only that subscription**. Persist it in the plugin
   before reporting. `POST /api/bot/channels/:channel/links/:id/status` with
   `{ "generation": 2, "observed": "paused", "detail": "Subscription paused" }`.
   Stale generations and success reports contrary to the request return 409; reread
   before retrying. Failures can be reported as `failed` or `unsupported` with detail.

Archiving changes only this channel's links to requested `paused`. A supported link
is `pending` until reported; an unsupported one is explicitly `unsupported`. A dead
plugin stays visibly pending (there is no inferred timeout success). Report failures
and pause outcomes also notify the coordinator as bot context. The UI labels these
as **plugin reports, not independent verification**. Bots without any registration
are listed as unmanaged, never claimed stopped. Existing external plugins must
adopt this extension before Hivemind can request/observe their suspension.

Resume sources only when `reopen.resumeSources=true`. With false, sources remain
paused even though the room reopens. A plugin owns retry/backfill policy and must not
silently discard provider events rejected while archived. Hivemind does not promise
exactly-once external effects; use stable bot event IDs and task action keys.

## Adaptive routing (Jev)

With adaptive routing enabled, each Human request addressed to a brain opens an
execution with its own `executionId`, announced in the
`[Hivemind adaptive topology · MODE · EXECUTION_ID]` directive (also listed as
`adaptiveExecutions` in `wait`/`whoami`). Naming room participants is delegation:
while the brain has an active execution, `configure` and `staff` must carry that
`executionId`, or they are rejected with 400 listing the active executions (403 for
another brain's execution, 404 unknown, 409 finished). Participants must fit the
applied worker budget and be available to that execution. New room work (including
`assign_task` with `room`) is allowed only when the applied mode is Room. Other room
actions (acknowledge, reconcile, summarize, archive, reopen) do not need it. Workers
never pass `executionId`.

```json
{
  "requestId": "sensor-room-staff-1",
  "expectedRevision": 4,
  "action": { "type": "staff", "participants": [{ "name": "Forge", "boundary": "Schema checks only" }],
    "reason": "Add the schema reviewer" },
  "executionId": "EXECUTION_ID"
}
```

See [task protocol](TASK-PROTOCOL.md#adaptive-routing-jev) and
[adaptive orchestration routing](docs/adaptive-routing.md).

## Bounds and persistence

SQLite transactions atomically store room changes, audit messages and task fences;
notifications publish after commit. Contracts are capped at 16 KiB, 16 workers and
eight entries per rule/limit/completion list. Rooms admit up to 64 running tasks and
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
Human and agents use the same persisted room state. Plugins, agent permissions and
provider configuration are not rewritten by installing this feature.
