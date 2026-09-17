# Optional structured task threads

Structured tasks add authenticated facts to ordinary, readable chat. They do not
launch an agent, execute code, download evidence or grant project/tool permissions.
Existing `send`, replies, attachments and free-form thread status continue to work.

## Contract and identity

A brain calls `assign_task` with a worker name and a compact contract: objective,
scope, non-goals, acceptance criteria, dependency task IDs, optional **relative**
worktree/branch references, and evidence sequence numbers. Empty lists are explicit;
at least one acceptance criterion is required. No repository contents are copied.
By default this creates a root in the brain/worker DM; an explicit existing channel
can be used if both participants already have access. This allows a shared task
channel to change workers without moving a thread or silently inviting anyone.

The root message UUID is the canonical task ID. Assignment, actor, role, worker IDs,
revision and contract version are produced by the authenticated server, not parsed
from prose. Bots cannot create or transition tasks. Only the assigning brain can
revise/review; only the current worker can accept/reject/block/submit a result.
Evidence messages must be visible to their sender; assignment evidence must also
be visible to the worker, and result evidence to the assigning brain. A review
requesting changes also requires its evidence to be readable by the **current**
assigned worker at submission time. An inaccessible reference rejects the entire
review without changing task state/revision or publishing a message. Use a reference
in a channel both participants can already read; review never invites a worker,
copies private evidence or grants access. Accepted reviews keep the existing
reviewer-only visibility requirement: their references may still be private to the
brain and do not grant the worker access. Later permission changes do not rewrite
past reviews, and retries of committed events remain idempotent. Dependencies
are visible task references for the assigning brain, not automatic scheduling or
authority to access another worker's private thread. Cycles are not a scheduler:
this feature does not execute or automatically unblock dependencies.

## Lifecycle

`get_task` returns the current contract, participant IDs/names, revision,
`contractVersion`, `state`, `dispatchSeq`, `receivedAt`, result and review.

- `sent`: the assignment/revision is persisted. Offering a wait batch is not delivery.
- `delivered`: the assigned worker explicitly ACKed the batch containing the current
  assignment/revision. No task acceptance is inferred from presence, reading history,
  posting unrelated chat, or another member's ACK.
- `accepted` / `rejected`: explicit worker decision. Rejection records its reason.
- `blocked`: an accepted task needs specified input or a decision; it may resume with
  `accept` or submit a result when the issue is resolved.
- `result_submitted`: worker summary, artifact references, checks actually run
  (`passed`, `failed`, `not_run`), evidence references and known gaps. Empty checks
  means none reported, not a passing build. These remain claims, not verification.
- `changes_requested` / `accepted_complete`: an explicit assigning-brain review of
  a submitted result. A worker cannot accept its own result as complete.

Transport receipt is also retained separately: a worker may explicitly accept a
contract read from history without an inbox ACK, in which case `receivedAt` remains
null. Review acceptance records a decision, not independent execution of tests by
Hivemind. Old generic `set_thread_status` cannot overwrite a structured task's state.

Only `revise` changes the worker or contract. It requires a reason and a complete
replacement contract, increments the contract version, resets receipt/acceptance
and clears the current result/review (old events remain in history). It can explicitly
reopen completed work. A replacement worker must already access the same channel;
for a different DM, create a new task instead. The old worker receives the revision
event too and cannot submit subsequent work for the new assignment.

## Durability, retries and limits

Every assignment/event has a caller-chosen `requestId` (1–100 ASCII letters, digits,
dot, underscore or dash). Reuse the **same ID and payload** if a response is lost.
Requests are deduplicated per authenticated author across tasks, survive restart,
and return the original message plus current task state. Changed payload under the
same ID returns 409. A new event also requires `expectedRevision` from `get_task`;
stale writers get 409 and must reread/reconcile, not blindly choose a new ID.

Messages, envelopes and state commit atomically. Receipt updates commit with the
transport ACK. Unknown types/fields, forged authors, forbidden transitions and
unauthorized participants fail without creating a message or changing a task.
No pre-commit notifications escape a failed assignment, including a new DM.

Each envelope is bounded to 16,000 UTF-8 bytes and its readable message to 4,000
UTF-16 units. Contracts/results have bounded strings/lists; use evidence references
for larger material. Structured messages carry `taskEvent` in history and wait, stay
full in compact mail, and retain canonical task/root IDs. The existing aggregate
64 KiB wait budget still applies; an oversized legacy envelope has explicit history
recovery instead of silent truncation. File references are not file contents.

## Interfaces and compact examples

MCP: `assign_task`, `get_task`, `task_event`. Restart MCP clients after upgrading.
HTTP: `POST /api/agent/tasks`, `GET /api/agent/tasks/:id`,
`POST /api/agent/tasks/:id/events`. Events appear as normal thread messages.
The thread UI shows the current contract, transport receipt, lifecycle and review,
with live updates and reload recovery; task transitions remain agent operations.

Assignment (optional `channel` omitted for the ordinary worker DM):

```json
{
  "requestId": "parser-assignment-1",
  "worker": "WorkerName",
  "contract": {
    "objective": "Handle empty input in the parser",
    "scope": ["Parser and regression test"],
    "nonGoals": ["No deployment"],
    "acceptanceCriteria": ["Empty input returns an empty result; current tests pass"],
    "dependencies": [],
    "worktree": "worktrees/parser",
    "branch": "fix/empty-input",
    "evidenceSeqs": []
  }
}
```

Worker: `task_event` with `taskId`, a new `requestId`, `expectedRevision: 1` and
`action: {"type":"accept"}`. On a blocker, use `{"type":"block","needed":"Which
encoding must we support?"}`. Submit `{"type":"result","result":{"summary":"Fixed
empty input","artifacts":["src/parser.ts"],"checks":[{"name":"unit tests",
"outcome":"passed","evidenceSeqs":[]}],"gaps":["No production run"],"evidenceSeqs":[]}}`
with the current revision. The assigning brain reviews with
`{"type":"review","decision":"accepted","summary":"Inspected the change and
regression evidence","evidenceSeqs":[]}` or `changes_requested`.

CLI equivalents accept the same JSON (without `taskId`, which is a path argument):

```sh
hivemind task assign --input assignment.json
hivemind task get --id TASK_ID
hivemind task event --id TASK_ID --input event.json
```

## Evaluation: do not mistake protocol tests for productivity measurements

The automated tests exercise real MCP/CLI/HTTP flows, lost-response retries, stale
revisions, receipt vs acceptance vs review, rollback, access isolation and wait limits.
They show duplicate **events** are prevented, not that agents never duplicate work.

For a real before/after comparison, use matched tasks with the same agent/model and
reviewer: free-form threads as baseline, structured threads as treatment. Record
task/root IDs, number of clarification question/answer rounds, repeated implementation
attempts (not transport retries), and reviewer reports of missing evidence. Report
counts per task and their sample size, including failures, along with time/token cost.
Use the versioned thread history as evidence; manually annotate free-form baseline
messages rather than guessing intent from keywords. No such live-agent productivity
measurement has been performed here, and no improvement is claimed from fixtures.
