# Jobs and task control

A job groups the tasks belonging to one Human request. A brain opens it with `job_event` (`type: "open"`, a stable UUID
`requestId`, `title`, optional `originMessageId`) or supplies `job: {title, originMessageId?}` to `request_worker`.
Subsequent requests use `job: {id}`. The origin must be a Human message visible to that brain in its project. Human
sees all jobs; a brain sees only its own. Job metadata never grants access to a private conversation.

Task changes update job counts and state in the same transaction: active work wins, then paused work; once every task
is terminal the job is done or cancelled. Human can close a settled job; a closed job cannot receive another task.
Migration 36 adds `jobs`, its request ledger `job_events`, task job links and the launch attempt kind.

## Human actions

`POST /api/ui/tasks/:id/control` accepts `requestId`, `expectedRevision` and an `action` object. Exact retries return
one committed result; a stale revision requires reloading the task. These actions also enter the task thread so the
brain and worker receive them through normal delivery.

- `{type:"pause", mode:"soft"}` asks the worker to checkpoint and stop task work. The session stays open.
- `{type:"pause", mode:"hard"}` asks for a checkpoint, then queues session closure after a durable 30-second grace
  period. This requires a joined task-bound worker. A checkpoint is still accepted while paused. The deadline survives
  a Node restart and the 15-second sweep processes it. Stopping a session does not prove a checkpoint was saved.
  If native closure fails, another explicit hard-pause action retries the stop; the sweep never retries it silently.
- `{type:"resume"}` resumes a soft pause immediately. For a hard pause it requires confirmed session closure and
  creates a new launch attempt for the same identity, using its template and current brain Approval/Auto mode.
  The worker rereads its handoff. Failed or rejected resumes remain paused for explicit retry.
- `{type:"cancel", reason}` cancels immediately. A task-bound worker is archived and its session is queued for closure;
  a fixed worker receives the event and remains an available identity.

An accepted result also archives and closes its task-bound worker automatically. Archive preserves history with an
`(archived)` label, removes the identity from the roster and rejects old tokens and ordinary resume-by-name. Template
capacity remains occupied while native cleanup is uncertain. No new mail or presence event relaunches a worker.

The Node process stores intent; only Hivemind Server.app executes a launch or kill. Resume attempts have no claim ticket
(the stored ticket hash is empty) and use the existing identity. Signed channel, native journal, private template
secrets and at-most-once crash handling follow [Terminal broker](terminal-broker.md).

## Activity, presence and terminals

`Agent.activity` has `state`, `since` and an optional hint. `ready` means a current or recent successful wait was
observed; `working` means recent mail delivery or an agent API action. Heartbeats establish transport liveness only.
If queued mail sees no wait or action progress for five minutes, activity becomes `stalled`, even if heartbeats continue
(the #258 regression). A launched worker that never claims its identity is also surfaced as stalled. `superseded`
records an actual inbox-session replacement; `offline` means there is no current work/listening evidence or liveness.
These are observations, not proof that an external model or tool has stopped.

Activity observations are in memory. After a server restart, a heartbeat alone does not restore ready/working status;
new wait/action evidence does. Pending mail is observed again by the sweep. Nothing relaunches automatically.

The Human snapshot carries `agentWork`; task, room and project events publish a full `agent-work` map. The UI no longer
polls the separate nav-status endpoint. Its pure `agentRuntime` selector keeps server activity separate from native
terminal evidence: an unavailable broker means unknown session state, not a stopped session. Reported terminal labels
remain display metadata and never give the Node server permission to execute a command.

Resume preserves Hivemind's existing name-based identity model. The server rejects an ordinary resume while hard-paused
unless its matching launch is dispatched; this is state fencing, not authentication against another local process that
can impersonate an agent. The signed native launcher authenticates execution authority, not the model process identity.

## Human task history API

`GET /api/ui/tasks` returns `{items,jobs,hasMore,nextCursor}` from one read transaction, with 50 tasks by default
and at most 100. Optional `project` is a project slug; `cursor` is bound to that project filter. Filtering happens
before the limit. `GET /api/ui/tasks/:id` returns `{item}`. Both are Human UI endpoints and reject agent credentials.
Each item contains the full task, its actual project, worker and brain identities, and the saved template label when
available. Archived or removed participants remain readable by id. The job list includes page-linked jobs and all
active empty jobs in scope, so a new Human request is visible before its first task exists.

Migration 37 adds indexes for the descending task cursor and saved launch-template lookup. It changes no task data.

## Task dashboard

Use **Tasks** in the project sidebar or mobile navigation, or **All tasks** in the project rail/top bar. Jobs group the
cards; active jobs remain visible before any task is assigned. Each card includes the latest saved checkpoint, template,
worker and brain, native terminal access when available, and the actions allowed by its current state. Requests reuse
the native launch-approval cards. A realtime change reloads the first page; use Load older tasks to browse further.

**Open thread** opens the task conversation. **Message brain** opens its DM and inserts a task link into the draft;
it does not send a message. Removed brains remain visible in task history but cannot receive new DMs.

Traffic is the worker's API response-byte counter since this server started, including archived workers. It is neither
per-task usage nor model token consumption and is unavailable after a restart until new traffic is measured. Unknown
control outcomes retain their request ID; check status before retrying. A failed native closure offers an explicit retry
and never silently launches another worker.
