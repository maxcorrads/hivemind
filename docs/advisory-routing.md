# Opt-in worker routing (prototype)

A worker may publish a versioned capability card using `set_capabilities`, or
`hivemind capabilities set --input card.json`. Read it first with
`get_worker_capabilities` / `capabilities get --worker UUID`; the initial revision
is zero. Only that worker can create/change its own card. `enabled: false` removes
it from suggestions, without rewriting past task history. Cards declare capability
tags, implementation/review/read-only modes, model/host, available context,
availability and a work-in-progress ceiling. Unknown model/host/context is `null`.
These are declarations, not a way to change a model or start a terminal.

```json
{"expectedRevision":0,"card":{"enabled":true,"capabilities":["typescript","parser"],"modes":["implementation","review"],"model":null,"host":null,"availableContext":128000,"availability":"available","maxInProgress":2}}
```

A brain can call `suggest_workers` for a task it can read, with
`requiredCapabilities`, `mode` and `category`. The CLI equivalent is
`hivemind task suggest --id TASK_UUID --input query.json`. Human has the same
explicit read-only form in the structured task card. There is no automatic call
on task open, no agent launch, no assignment and no authorization change.

Required tags/mode/context are hard filters. Review mode excludes the current
implementation worker. Workers without outcomes remain eligible by default;
`minReviewedResults` and `minimumAcceptedRate` impose explicit evidence constraints.
The latter uses the lower descriptive 95% Wilson bound, not a one-success 100%
claim. Sorting prefers declared available over busy, then lower visible workload,
then name. It intentionally does not reward a history of easy tasks. Suggestions
are paginated in groups of 12; `nextOffset` reaches all eligible cards, including
cold starts. Re-read changing snapshots before choosing. Missing private workload
means the visible count is incomplete: confirm real capacity with the worker.

## Evidence is narrow and inspectable

Only the assigning brain can `record_routing_outcome` after its real review. The
call confirms task revision, category and the current opted-in capability revision.
The verdict and worker come from the existing task, not a submitted score. A task
contributes at most one current observation; later review changes replace, not add
to, that observation. Relabelling its category/configuration is rejected. Any task
revision after the classified review removes that stale sample from suggestions.
The configuration is explicitly declared by the reviewer, not verified from the
external host. Samples are segregated by category and model/host/capability/context
configuration. Only caller-visible task evidence is counted, at most the 64 most
recent observations within 90 days. Small samples and assignment selection bias
remain limitations; this is not a general worker ability score.

Provider cost stays **unknown**, never zero or an estimate from seniority, bytes or
idle polls. A cheap choice is not preferred over an explicit capability/quality
constraint. No break-even task size is claimed: consider a direct workflow for
small or tightly coupled tasks and use controlled evaluations before inferring
benefit. Operational prototypes are separate from real-provider quality evidence.

`record_routing_override` / `task routing-override` records a reason in the task
thread using an idempotent request ID and expected task revision. Human can do the
same in the UI. It is a preference only; the assigning brain still explicitly
revises a contract/worker through the normal task protocol, and all claims,
dependency and room rules still apply. There is no punitive worker ranking.

## Bounds and scope

Cards are limited to 256 per project; observations to 2,048 per project. Writes
are transactional and revision fenced. Observations older than 90 days are pruned
on writes, without deleting task history. All state is persisted in the local
SQLite database and is removed with its project/task/worker. Worker cards, private
task contents and evidence cannot be obtained through another project's identity.
Suggestions compare only opted-in workers who already have task-channel access.

Tests exercise actual HTTP contention, CLI/MCP boundaries, private evidence,
configuration changes, stale reviews, cold starts, pagination, rollback/restart,
UI navigation races and retrying an uncertain recorded choice. These verify the
prototype's contracts, not a measured improvement in real-agent task quality.
