# Task checkpoints and resume handoffs

An optional worker `task_event` action of `checkpoint` records completed steps,
open questions, the next concrete action, relative artifact references and checks
actually performed. It does not execute code, clear a model context, infer missing
work, or accept a result. The current task contract remains authoritative.

```json
{
  "taskId": "TASK-UUID",
  "requestId": "parser-checkpoint-1",
  "expectedRevision": 2,
  "action": {
    "type": "checkpoint",
    "checkpoint": {
      "completedSteps": ["Reproduced empty-input failure"],
      "unresolvedQuestions": ["Does an empty line represent an empty record?"],
      "nextAction": "Confirm the empty-line rule before changing the parser",
      "artifacts": ["tests/parser.test.ts"],
      "checks": [{"name": "focused parser tests", "outcome": "failed", "evidenceSeqs": []}],
      "evidenceSeqs": []
    }
  }
}
```

Use an actual task UUID. Only its current worker can checkpoint, after accepting
its contract. The event increments task revision and checkpoint version, but not
contract version, receipt or task lifecycle state. Its objective, worktree, branch,
worker, saved task state and message/sequence references are stamped by the server.
Checkpoints are permitted while room interruption is requested: saving a handoff
is not permission to continue implementation, and is not confirmation of stopping.

The latest checkpoint is pinned in `get_task` and the Human thread card. Earlier
ones remain readable task messages with their checkpoint version; the pinned
version supersedes them. Same request ID and payload retries return the original
message without another event; changed payload or stale task revision conflicts.
The checkpoint, readable message and task revision commit together. Later contract
revision/reassignment retains the old report but marks it `contract_changed`;
a later task event marks it `task_changed`. An old worker cannot overwrite the
new owner's handoff. Checks remain explicitly unverified reports.

## Discover and recover

MCP `get_handoffs` and `hivemind task handoffs` return up to five unfinished tasks
assigned **to** the authenticated worker or **by** the authenticated brain. Continue
with `beforeTask=nextCursor` / `--before TASK_UUID`. Membership and project filters
apply in SQL before LIMIT. The cursor orders stable task UUIDs, not recency; no claim
is made that the first row is the most urgent or latest task. Completed tasks remain
available through explicit `get_task`/history, but are omitted from resume discovery.
The join response includes the same bounded summary page and pagination instruction.
There is no global last-join task fallback or automatic task execution.

Read MCP `get_handoff` / `hivemind task handoff --id TASK_UUID` for one full handoff.
HTTP equivalents are `GET /api/agent/handoffs?beforeTask=TASK_UUID` and
`GET /api/agent/tasks/TASK_UUID/handoff`. Output includes current task state,
checkpoint age, contract/task freshness, whether later persisted thread messages
exist, and an explicit history expansion reference. A full handoff is capped at
32 KiB, independent of the existing 16,000-byte event/4,000-unit readable-message
limits. References never grant file access. Later **unsaved** work may exist even
when no newer message is stored. Age is wall-clock age clamped at zero, not a lease.

`clear_context` now explicitly asks the worker to save relevant checkpoints where
possible before following the request. It remains a message, not a host-runtime
reset or cancellation API; it must not be triggered automatically after results.
A crashed process can only recover the latest *saved* report. Inspect actual work
and evidence before acting, especially after reassignment or a later decision.

## Validation and evaluation

Storage tests cover revisions, retry conflicts, transaction rollback, older-history
retention, stale contracts, access/evidence boundaries, capped discovery and restart.
Real HTTP/stdio/CLI tests recover the same report after a fresh session and verify
that raw credentials are not exposed to the model. UI tests preserve the highest
revision and label outdated reports and unverified checks explicitly.

These are transport/state tests, not measurements of model recovery quality or
real developer time saved. Recovery-time/repeated-exploration comparisons belong
to the controlled evaluation harness in issue #29; no such benefit is asserted here.
