# Advisory task claims and dependency gates (prototype v1)

A claim records a brain's **coordination intention**, not ownership of the OS,
Git worktree, files or an external model process. It does not change the task's
assigning brain or worker, launch work, cancel a host, or grant channel access.
Ordinary chat and tasks without claims still work. Dependency declarations now
have an explicit gate, described below; this is an intentional protocol change.

Use the existing `task_event` MCP tool or
`hivemind task event --id TASK_UUID --input event.json`. Every event requires a
stable `requestId` and the `expectedRevision` from `get_task` / `task get`.
The message, task snapshot, claim and retry ledger share one SQLite transaction.
Two competing brains with the same revision cannot both win. Retrying the same
request returns the same message, without a second notification.

## Actions and authority

A brain already able to read/post in the task channel may send:

```json
{
  "requestId": "parser-claim-1",
  "expectedRevision": 1,
  "action": {
    "type": "claim",
    "leaseSeconds": 300,
    "paths": ["src/parser", "tests/parser"],
    "overlapAcknowledgements": []
  }
}
```

Only the claim coordinator can `renew_claim` (leaseSeconds and current overlap
acknowledgements). Only that coordinator or the actual assigning brain can
`release_claim` (reason). Only the actual assigning brain can `reconcile_claim`
(reason, leaseSeconds, paths and acknowledgements). Reconciliation explicitly
puts the advisory coordinator back under the assigning brain; changing the
worker still requires the normal versioned `revise` event. A claim never grants
permission to revise/review another brain's task. Workers and bots cannot manage
claims. Human can inspect them and instruct the assigning brain; this prototype
does not add a Human bypass to the existing task-event role contract.

Leases range from 30 seconds to one hour. Expiry or a worker/contract change marks
the claim **uncertain** on retrieval/render/action, not released. It does not run
or reassign anything. An uncertain claim blocks new acceptance, result submission
and accepted review until explicitly reconciled/released. Block/checkpoint
reports remain possible. A completed review releases held advisory intent as
part of that explicit review transaction; a reported result alone does not.
Lease age uses the local system clock; it is not a monotonic distributed lease.
Clock rollback can delay observed expiry. Do not treat a lease as proof that a
worker is stopped or that editing is exclusive.
A room stop still blocks new work; releasing a claim or saving a checkpoint is
only a report and does not confirm that the host actually stopped.

## Intent overlaps and limits

Up to eight exact relative file/module references may be declared. Prefixes are
compared by path segments: `src/a` overlaps `src/a/file.ts`, not `src/ab`.
No traversal, absolute paths, empty/dot segments, control characters or globs.
This is lexical intent, not filesystem inspection or canonicalization: symlinks,
case-insensitive aliases and edits outside declared intent are not detected.

Before claiming, use `preview_task_claim` with `taskId` and `paths`, or
`hivemind task claim-preview --id TASK_UUID --input paths.json` where the JSON is
`{"paths":["src/parser"]}`. This read-only preview returns the task revision and
visible task/claim-version pairs; it does not reserve ownership. Claim rechecks
both overlap versions and task revision, so a racing change may require another preview.

`task.coordination.overlaps` explains visible intersections with task ID, claim
version and intersecting declared paths. To cooperate intentionally, repeat each
visible pair in `overlapAcknowledgements`. A renewal/reconciliation changes the
claim version; stale acknowledgements cannot authorize a later operation.
Only already-visible task intentions are discovered automatically. Explicit
acknowledgement IDs are authored references in the task event and stay readable
in that task history, like dependency references; they do not grant access to
the referenced private task. Share references intentionally. **No warning does not mean
exclusive ownership**: private intentions, undeclared paths and real files are
not a global lock registry. More than twelve overlaps requires narrower intent;
a truncated view is labeled, not silently treated as clear.

At most 256 held/uncertain claims per project, eight per coordinator and four per
worker may be admitted. These are limits on the optional advisory ledger, not a
universal task-assignment capacity or measured optimal agent count. Expired
claims still consume capacity until explicit resolution. Private capacity
refusals disclose no task/path/identity metadata. Active claims are not silently
evicted. Partial indexes and bounded projections limit retained/query work.

## Dependency graph

Assignment/revision validates up to 256 referenced ancestors in the same project
and rejects self/transitive cycles before mutation. Direct references require
channel visibility. Hidden transitive ancestors are used only for a generic
bounded graph check and their metadata is not exposed. A large or broken legacy
graph fails visibly; removing bad edges through a revision is the repair path.

Acceptance, result submission and accepted review require every **immediate**
prerequisite to be `accepted_complete`, not merely delivered or result-submitted.
The server rechecks this during each mutation. Reopening a direct prerequisite
blocks these operations again. There is no cascading cancellation or automatic
invalidation of already completed downstream reviews. Brains must explicitly
review/revise affected downstream contracts when semantics change.

`task.coordination.dependencies` says accepted-complete, not-complete or
unavailable without revealing private state. The Human card displays these
statuses and claim expiry. This is a view at the last fetch/render, not a live
clock or subscription to every prerequisite. Re-read `get_task` before acting;
mutation guards remain authoritative even when a UI snapshot is stale.

## Verification and evaluation boundary

Tests exercise competing real HTTP requests, real MCP/CLI retry/release,
rollback/notification atomicity, stale revisions, restart, expiry without
reassignment, independent worker/coordinator/project caps, overlap acknowledgements,
role/project/privacy boundaries, dependency cycles/budget/accepted-review gates,
escaped UI and room-stop semantics. The transitive-cycle regression fails on the
previous TaskStore implementation and passes with these guards.

This is the optional #30 prototype, not a measured productivity improvement.
Actual duplicate implementation, conflict/rework, coordination overhead and task
quality comparisons belong to #29. Synthetic correctness tests are not evidence
that a ledger beats simpler DMs for every workload.
