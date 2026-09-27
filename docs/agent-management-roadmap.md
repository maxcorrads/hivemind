# Agent orchestration and token efficiency roadmap

Status: Phase T is in #275; A1 is in #281 → #282 → #283 → #285, with #284 integrated into #285. All remain unmerged. A2 is in #286 → #287 → #288. A3 is in #289 → #290. A4 is in #291 → #292, including Phase T #275. A5 is in progress; Phase 3 and T2 remain planned. Updated 2026-09-27; the historical analysis below was written against `8f0e583` (#265).

This document is the single source of truth for a multi-phase effort: brains launch task-bound workers from Human-defined templates (automatically or after Human approval), Human follows every job and task with its progress and can pause, cancel or discuss it, and agents spend fewer tokens on Hivemind traffic. It is written so that work can resume from here alone, without the conversation that produced it. Each phase has its own GitHub issue; the tracking issue, #274, lists them all (see [Issues](#issues)).

## How to resume work

1. Read [Decisions](#decisions) and [Development safety rules](#development-safety-rules) first.
2. Open the tracking issue and pick the first unchecked phase. The recommended order is the order of [Phases](#phases).
3. Each phase section lists its goal, design, steps, acceptance criteria and risks. Its issue repeats the same content; if they diverge, update both.
4. When a phase changes what agents receive (MCP tool text, wait payloads, standing orders), follow the [protocol-change checklist](#protocol-change-checklist).
5. Tick the phase in the tracking issue and update the **Status** line at the top of this document when a phase is merged.

## Goals

- Brains launch the workers they need, one per task, from worker templates Human defined for the project, either automatically or after Human approves each launch.
- Task-bound workers live exactly as long as their task: they are closed and archived when the task is accepted or cancelled.
- Human sees every job (a request to a brain) with its tasks and their progress, per project and across projects, and can pause, resume, cancel or discuss any task with its brain.
- Show what each agent is really doing (ready, working, stalled, offline), not only whether its MCP process is alive.
- Keep the Node server unable to run commands: launches happen only in Hivemind Server.app, only from Human-defined templates.
- Reduce the tokens agents spend on Hivemind traffic, and measure it.

## Decisions

Taken by Human on 2026-09-27. Do not reopen them without a new Human decision.

| Topic | Decision |
| --- | --- |
| Platforms to optimize for | Hivemind.app on the Mac and the iPhone/iPad app. The plain browser keeps working but cannot launch or approve launches. |
| Who launches | **Hivemind Server.app** (always running in the menu bar), so launches and approvals work with no window open and from the iPhone. The Node server never runs a command. |
| What a brain may launch | Only **worker templates** Human defines per project: command (e.g. `codex2`, `opencode-hm`), model, effort, flags, environment variables, secrets, seniority and a "when to use" description. A brain picks a template and a task; it never supplies a command. |
| Limits | A maximum number of concurrent instances **per template**. No other cap. |
| Auto vs approval | A toggle **per brain**. A new brain starts in **Approval** mode. |
| Approvals | In Hivemind.app on the Mac and in the iPhone/iPad app (card plus native notification). Not in Telegram. |
| Template secrets | Human enters them in the template like any other field. They go only to Hivemind Server.app, which keeps them in the macOS Keychain and hands them to the session through the existing private launch file. They are never stored in the Node database. |
| Worker lifecycle | A task-bound worker is created for one task. When its task is accepted-complete (or cancelled) its session is closed and the worker is **archived**: gone from the roster, history kept. |
| Worker names | Tied to the task, e.g. `Forge-settings-page` (mentionable, valid in a tmux session name; a numeric suffix on collision). |
| Isolation | Each task-bound worker creates its own git worktree and branch for its task as its first action. |
| Pause | **Both** kinds, chosen per action: *soft* (the worker saves a checkpoint and stops; its session stays) and *hard* (checkpoint, then the session is closed; Resume relaunches the same worker with its handoff). |
| Cancel | Cancels the task and **closes its worker at once**. |
| Task views | Grouped by **job** (the Human request) with its tasks; per project in the sidebar **and** a global view; detailed progress (checkpoints, completed steps, next action). |
| Talking about a task | Both: post in the **task thread** (brain and worker read it) or open the **brain's DM** with the task referenced. |
| Fixed workers | Workers launched by hand as today **stay** and coexist with task-bound workers. |
| Auto-resume | Hivemind never relaunches an agent by itself because mail arrived. The only automatic launches are brain requests from templates, gated by the brain's mode. |
| Identity editing by Human | Human may rename, change focus and seniority, and edit a worker's capability card (Phase 3). |
| Work order | Phase T first (done), then the orchestration phases A1–A5 in order; Phase 0 refactors happen where each phase needs them. |

## Development safety rules

Human runs a production Hivemind while this work happens. Nothing done for this roadmap may disturb it.

- **The running setup lives in another checkout.** Hivemind Server.app, Hivemind.app and every agent's `hivemind mcp` process run from `~/Documents/develop/hivemind` (server on `127.0.0.1:7420`, state in `~/.hivemind`, tmux server `-L hivemind`). Development happens in a separate checkout, `~/Documents/develop/hivemind-dev/hivemind`. Never edit, build, install or run anything in the production checkout.
- **Never bind 7420 or 7421.** Do not run `npm run dev`, `npm start`, `browser:server` or the coordination benchmarks' live executor (it uses port 7420) from the development checkout while the production server runs. The unit and integration suites start their own servers on ephemeral ports and are safe.
- **Never touch `~/.hivemind`.** Any manual server run uses a throwaway home and a free port, for example `HIVEMIND_HOME=$(mktemp -d) npx tsx src/cli.ts serve --port 7520` (`HIVEMIND_PORT` also works). The instance lock is per home, so a separate home never conflicts with the production server.
- **Never touch the production tmux server** (`tmux -L hivemind`), the production broker socket or `~/Library/Application Support/Hivemind/`. Never run a development build of Hivemind Server.app while the production one runs: they share the broker socket, the discovery file and the Keychain service name. Swift work is tested with `swift test` in `macos/` (fakes only) until Human decides how to run a development app side by side.
- **Migrations.** Phases A1–A4 add SQLite migrations. They apply to `~/.hivemind` the first time Human runs the new code in production. Call this out in each PR, and remind Human to back up `~/.hivemind` with every server stopped before upgrading (see [Storage, backup and restore](storage-and-backup.md)).
- **Agent protocol changes need MCP restarts.** After upgrading, every running agent's MCP client must be restarted (see the [protocol-change checklist](#protocol-change-checklist)).

## Current state

Findings from reading the code at `8f0e583`. File paths are relative to the repository root.

### Identity and lifecycle

- An agent is a name, role, seniority, focus and project (`src/shared/types.ts`, `Agent`). Brains and workers have no credentials: `join` with `resume=Name` opens a new session and supersedes the old one in the same transaction (`src/server/services/identity.ts`, `replaceAgentSession`). See [Identity lifecycle](identity-lifecycle.md).
- Names are picked at random from `src/server/names.ts`. They are the resume key, the `@mention` target and part of the tmux session name. Removed names stay reserved.
- Role, seniority and project cannot change on resume (`assertResumable` in `identity.ts`). Focus is set at first join and is ignored on resume. The standing orders say "Your identity is fixed: never change role or seniority" (`src/shared/standing-orders.ts`).
- Removal is a tombstone (`src/server/services/agent-lifecycle.ts`): memberships, reads, subscriptions and drafts are deleted, tasks assigned to the agent are cancelled, tasks it assigned stay open without a reviewer. The impact is reported afterwards as a system message in `#general`; the confirm sheet (`web/HiveSheets.tsx`, `AgentConfirmSheet`) does not show it beforehand. The agent's tmux session keeps running.

### Presence

- `online` means "the MCP process is alive". The MCP process pings `/api/agent/ping` every `MCP_HEARTBEAT_MS` (150 s). `sweepPresence` marks an agent offline after `PRESENCE_IDLE_MS` (10 min) without requests, unless a wait is in flight (`identity.ts`). An agent blocked in a wait counts as present.
- MCP `wait` polls the server in `MCP_WAIT_POLL_MS` (20 s) bursts inside one tool call (`src/mcp/wait-loop.ts`, `src/server/services/delivery.ts`). `Waiters` (`src/server/services/waiters.ts`) knows whether an agent is currently inside a burst.
- Nothing distinguishes an agent waiting for mail, one handling mail, one stopped at a permission prompt in its terminal, and one whose host stopped calling wait. Issue #258 documents the last case: Cursor's 60 s MCP client timeout makes the model stop calling `wait` while heartbeats keep the agent "online" and mail piles up.
- The roster status line falls back to `idle`/`offline` when the agent has no task (`web/nav-model.ts`, `agentStatusLine`). Task-derived work comes from `/api/ui/nav-status` (`web/use-nav-status.ts`), presence from the snapshot: two sources with different refresh paths.

### Launch and terminals

- The Launch sheet (`web/LaunchSheet.tsx`, about 1000 lines, about 25 `useState`) builds a command plus prompt (`src/shared/launch-prompt.ts`, `src/shared/launch-models.ts`). In the apps it starts the agent in its own tmux session through the broker ([Terminal broker](terminal-broker.md)).
- Software, model, effort, flags, per-agent model overrides (`tunes`) and environment variables are kept only in the browser's `localStorage` (`hivemind-launch`). The server does not know which CLI or model an agent runs, and a resume from the iPhone or another window uses different settings.
- Resume is all-or-nothing in the sheet ("Resume same employees" lists every agent). There is no per-agent Resume, Restart or Stop in the roster.
- A new agent's session is `hm-<project>-new-<n>` until it joins; the Terminals sheet shows it as "Waiting to join" (`web/SessionsSheet.tsx`). The agent reports its session through `HIVEMIND_TMUX_SESSION`, which Codex drops unless its config lists `env_vars` ([Agent connection](agent-connection.md#terminal-session-label)). The fallback maps an unlabelled agent to the one live session the broker recorded for its name (`recordedSession` in `web/use-terminal.ts`).
- The agent ↔ session logic is spread over `web/use-terminal.ts` (`agentTerminalSession`, `liveSession`, `recordedSession`, `agentLiveSession`), `web/ChannelDesk.tsx` (`hadTerminal` state for the DM's Terminal tab) and `web/SessionsSheet.tsx` (`sessionOwner`, `sessionStatus`).

### Roster and agent UI

- The roster (`web/AgentList.tsx`, rendered by `web/Sidebar.tsx`) shows Human, brains, workers by seniority and bots. Per-row actions: Clear context (workers only) and Remove. Clicking an agent opens its DM (`App.tsx`, `onAgent`).
- Agent information is scattered: status line and queue badge in the roster, `InboxReceipt`, the DM header (`DmTitle` in `ChannelDesk.tsx`), the DM's Terminal tab. There is no agent overview.
- Offline agents stay in the roster forever; Remove is the only way out and it is final.

### Brain delegation

- The brain-facing roster (`GET /api/agent/agents`, MCP `agents`) returns agents with online/offline only; `createdAt` and `terminalSession` are stripped (`src/server/app.ts`). No workload, queue or wait state.
- Capability cards (`src/server/routing.ts`, `src/shared/routing.ts`) are opt-in and self-declared by workers through `set_capabilities`. The UI shows them only in `web/WorkerRouting.tsx`. Human cannot edit them.

### Token spend

Measured with `node --experimental-transform-types` on the source (script in [Measuring](#measuring)):

| Item | Size | Paid |
| --- | --- | --- |
| Standing orders, worker | 6,584 chars | once per new session (resume returns `ordersRef: "unchanged"`) |
| Standing orders, brain | 7,671 chars | once per new session |
| MCP tool descriptions | 31 tools, 8,163 chars, plus JSON schemas | in every turn's tool list (usually cached) |
| Of which brain-only tools | 1,675 chars (`assign_task`, `worker_match_*`, `preview_task_claim`, `create_channel`, `invite`, `clear_context`) | also shown to workers, who cannot use them |
| Pretty vs compact JSON | 3,354 vs 2,626 chars on an 8-item mail sample (about 22% larger) | on every tool result |

Where the waste is, in code:

1. **Pretty-printed tool results.** `text()` in `src/mcp/index.ts` returns `JSON.stringify(data, null, 2)`. `waitWireBytes` in `src/server/wait-format.ts` also budgets the 64 KiB wait page with the pretty-printed form, so fewer messages fit per page.
2. **Task contracts sent twice.** `packWait` (`wait-format.ts`, `full()`) puts both `taskEvent` (the structured envelope with the whole contract) and `body` (the same contract rendered by `taskBody` in `src/shared/tasks.ts`) in each task mail item.
3. **Fixed disclaimers in task bodies.** `taskBody` appends sentences such as "Advisory coordination only: no filesystem lock…", "Checkpoint only: not completion…", "Result submitted; not accepted-complete until the assigning brain reviews it." The same rules are already in the standing orders.
4. **Repeated wait fields.** Every wait result carries `you` (name, role, seniority, focus up to 512 chars, online, project) and `next` (`WAIT_NEXT`, about 300 chars), even when unchanged.
5. **Context growth.** `clear_context` is only an instruction (`src/server/services/messages.ts`); it cannot reset the CLI's context. Long sessions keep growing.
6. **One tool set for all roles.** Tools are registered at MCP start, before `join`, so workers see brain-only tools and their schemas.


### Tasks and launching

- Brains split work with `assign_task` (`src/server/tasks.ts`, `src/shared/tasks.ts`), but only to workers Human launched by hand. Task states: `sent`, `delivered`, `accepted`, `blocked`, `result_submitted`, `changes_requested`, `rejected`, `accepted_complete`, `cancelled` (the last only when the worker is removed). There is no pause, no Human cancel and no parent "job" grouping tasks.
- Tasks are listed only per channel, in the channel's Tasks tab (`web/ChannelDesk.tsx`, `web/TaskCard.tsx`); `agentWork` gives one status line per agent. There is no cross-channel or cross-project task view.
- Only the terminal broker inside Hivemind Server.app can start a terminal. Today it takes requests only from a page in Hivemind.app or the iPhone/iPad app ([Terminal broker](terminal-broker.md)). The Node server has no terminal API.
- Hivemind Server.app starts the Node server with a per-start instance secret (`HIVEMIND_INSTANCE_SECRET`, read and deleted by `src/server/instance-proof.ts`; kept by the app in memory and in the `0600` `server.json`). Only Hivemind Server.app and that server know it ([Verifying the server](macos.md#verifying-the-server)).
- Launch secrets reach a session through a private `0600` file the session reads and deletes; today the only allowed secret name is `OPENCODE_API_KEY` (`LaunchSecrets.swift`).

## Phases

Recommended order: T (done) → A1 → A2 → A3 → A4 → A5, then 3 and T2. Phase 0 refactors are done inside the phase that first needs them (listed there). Superseded phases are listed at the end.

### Phase T — Token efficiency quick wins (done, #275)

Implemented in #275: compact JSON for MCP tool results and the CLI `wait`; the MCP `wait` shows `you` only on the first wake of a session and when it changes, the full `next` only on the first wake (then a short reminder), no duplicate `instruction`, no empty legacy arrays; compact task mail carries only the body's header line beside the full `taskEvent`; task bodies lose disclaimers the standing orders already state; the Human snapshot has `agentTraffic`, the JSON bytes the agent API returned per brain/worker since server start (in memory, no migration). Measured −33% to −41% on task wakes. Breaking for agents: restart MCP clients after upgrading.

### Phase 0 — Foundations (folded into the phases that need them)

- A single pure selector `agentRuntime(agent, snapshot, terminals, work)` replacing the agent ↔ session and status logic spread over `web/use-terminal.ts`, `web/ChannelDesk.tsx`, `web/SessionsSheet.tsx` and `web/nav-model.ts` (needed by A4/A5).
- Agent work delivered with presence (snapshot and realtime events) instead of the separate `/api/ui/nav-status` polling (needed by A4).
- `web/LaunchSheet.tsx` split into a `useLaunchForm` hook and sub-components (needed by A1, which reuses its command builder for templates).

### Phase A1 — Worker templates and task-bound identities

**Goal.** Human defines, per project, the workers brains may launch; a launched worker gets a reserved, task-bound identity before its process starts.

**Design.**

- Table `worker_templates` (migration): `id`, `project_id`, `slug` (unique per project), `label`, `description` ("when to use", shown to brains), `software`, `model`, `effort`, `extra_flags`, `environment` (non-secret, rules of `src/shared/launch-environment.ts`), `secret_names` (names only), `seniority`, `focus`, `max_concurrent` (required, ≥1), `enabled`, `revision`, timestamps.
- Human-only API: `GET/POST/PATCH/DELETE /api/ui/projects/:id/worker-templates` with revision checks. Deleting a template with running instances is refused.
- Secrets: the template editor sends secret values only to Hivemind Server.app over the native bridge (new messages, e.g. `template-secret-set {templateId, name, value}` / `template-secret-delete`, relayed to the broker or the launcher service; from iOS through the remote gateway). Server.app stores them in the Keychain under `hivemind.template.<templateId>.<NAME>`. The Node server stores only `secret_names`. Generalize `LaunchSecrets` from the single `OPENCODE_API_KEY` to template-declared names (same value rules, same denylist as environment variables).
- Launch command: built by the Node server from the template with the shared launch builder (`src/shared/launch-prompt.ts`), the reserved name and a one-time claim ticket. The prompt never contains brain-supplied text: the worker reads its task with `get_task` after joining.
- Task-bound identity: a **pending** agent row (new state; no session, invisible to agents, excluded from roster, mentions, delivery and Jev capacity) with a reserved name `<Base>-<task-slug>` (numeric suffix on collision) and `template_id`, `task_id`, `origin` (`template`). The launch prompt joins with `claim=<ticket>` (random, single-use, expires after 30 minutes; stored hashed). Claiming turns the pending row into a normal worker and records its tmux session. An unclaimed identity expires and its launch request fails.
- The tmux session is `hm-<project>-<name>` from the start, so no `new-<n>` session and no dependency on Codex `env_vars` for mapping.
- UI: a **Worker templates** sheet in Project settings (list, create, edit, duplicate, disable), with a command preview; secrets are masked, write-only fields.

**Steps.** Migration and store; API with validation and tests; pending identities and `join` claim (identity service, MCP `join`, CLI); launch-command builder for templates; bridge messages and Keychain storage in Server.app (Swift, `swift test` with fakes); template editor UI; docs ([Identity lifecycle](identity-lifecycle.md), [Agent connection](agent-connection.md), [Terminal broker](terminal-broker.md), [macOS apps](macos.md)).

**Acceptance.** Templates round-trip with revisions; secrets never reach the Node database or any log (tested); a pending identity can be claimed once with its ticket and never by name; pending identities are invisible where specified (tested); the launch command contains no brain-supplied text.

### Phase A2 — Launcher in Hivemind Server.app

**Goal.** Launch, stop and hard-pause task-bound workers from a durable queue, with Human approval or automatically, without giving the Node server a way to run commands.

**Design.**

- Table `launch_requests` (migration): `id`, `project_id`, `brain_id`, `template_id`, `task_id`, `job_id`, `agent_id` (pending identity), `ticket_hash`, `state` (`awaiting_approval`, `approved`, `launching`, `launched`, `failed`, `rejected`, `cancelled`, `expired`), `reason`, `requested_at`, `decided_by`, `decided_at`, `session`, `error`. Table `launcher_commands` for `kill` (stop, hard pause, cancel, archive) with the same durability.
- Launcher channel: `GET /api/launcher/next` (long poll) and `POST /api/launcher/:id/result`, outside Human and agent auth, authenticated by an HMAC over method, path, timestamp, nonce and body hash with the **instance secret** (±60 s window, nonce replay cache). Without an instance secret (a `hivemind serve` started by hand) the endpoints answer 404 and the UI says launches need Hivemind Server.app.
- Server.app `LauncherService`: long-polls the queue, launches through its in-process broker with the template's command, cwd (project worktree), environment and Keychain secrets, reports the session name or the error; runs `kill` commands. Idempotent by request id (a session that already exists counts as launched). Survives restarts of either side.
- Approvals: a request from a brain in Approval mode waits in `awaiting_approval`; Human sees a card in Hivemind.app and the iPhone/iPad app (plus a native notification) with **Approve**, **Change template** and **Reject**. Auto mode goes straight to `approved`. Per-template `max_concurrent` is enforced when approving (a request over the cap waits, visible as such).

**Trust boundary (document it in [Terminal broker](terminal-broker.md) and [Local Human security](local-human-security.md)).** Server.app trusts the Node server it started and verified, as Hivemind.app already trusts its page. A brain never supplies a command: only a template id and a task. Any local process can pass for a brain (identities have no credentials), so in Auto mode such a process could start workers, but only from Human's templates, within their caps.

**Acceptance.** Queue and HMAC channel tested (replay, clock skew, wrong secret, no secret); Swift launcher tested with fake broker and fake HTTP; a request is launched exactly once across restarts; caps enforced; approvals from Mac and iOS.

**Implementation decisions (2026-09-27).** A2 is split into the durable Node queue/channel (#286), the Swift launcher/native approval transport (#287), and approval cards (#288). Local checks passed at each exact commit; the approval UI additionally passed all 99 browser contracts and the launcher passed 664 Swift tests with fakes. Approval mutations travel through the verified native bridge and broker to the signed launcher channel; the ordinary Human cookie deliberately cannot approve a launch. Signing a request does not authenticate its response, so the launcher also verifies the server's instance proof. The launcher journals intent before a side effect and the result afterwards: after an uncertain crash it reconciles an existing session, but never launches again solely because a session disappeared. An uncertain launch is reported as a failure requiring an explicit new request. This provides at-most-once execution rather than promising an impossible atomic transaction across SQLite and tmux. Server.app posts Mac approval notifications even when Hivemind.app has no open window; iOS reuses its existing native notification bridge. A suspended or closed iOS app has no background push transport, and sees pending requests when reopened.

### Phase A3 — Brain tools and per-brain mode

**Goal.** Brains request and release task-bound workers; Human sets each brain to Auto or Approval.

**Design.**

- `agents.launch_mode` (`approval` default, brains only), toggled by Human in the roster/agent panel; visible to the brain in `whoami`.
- MCP tools (brain only, 400-character descriptions):
  - `worker_templates`: the project's enabled templates with slug, label, description, seniority, cap and instances in use.
  - `request_worker {requestId, template, contract, job?}`: atomically creates the task assigned to a new pending identity and the launch request; returns the task and the request state (`awaiting_approval` or `approved`). Also accepts an existing unassigned or cancelled task to revise onto a new worker.
  - `release_worker {worker, reason}`: closes and archives a task-bound worker the brain owns (its task must be finished, cancelled or revised away).
- The brain learns launch outcomes as task events (launched, failed, rejected, expired).
- Brain standing orders: prefer an idle suitable worker; one task-bound worker per task; pick the template by its description; never ask for a template you do not need; release when the task ends. Workers' standing orders: a task-bound worker creates its worktree and branch first, works only on its task, and stops after its result is reviewed.
- Enrich the brain roster (`agents`) with each worker's activity state, open tasks and origin (fixed or template).

**Acceptance.** End-to-end in tests with a fake launcher: brain requests, Human approves, the worker claims, accepts, submits, the brain accepts, the worker is archived. Auto mode skips approval. Tool descriptions within budget; rules checklist updated.

**Implementation decisions (2026-09-27).** Migration 35 adds the brain launch mode, distinct archive timestamp,
reservation ownership and retry fingerprint. A worker request and its dedicated private task thread commit together;
exact retries reuse the request. Replacing an existing task moves only its task thread into a new private channel,
without granting access to unrelated DM history. Room tasks retain their room contract and cannot be moved by this API.
Archived workers cannot resume or authenticate. Template capacity excludes requests awaiting approval but includes
uncertain sessions until a kill acknowledgement. Explicit release keeps its reason in the task thread. The optional
job field is rejected explicitly in this intermediate phase; A4 introduces its real persistence and grouping. The full
wait/action-based activity projection is also completed in A4. MCP clients must restart to discover the added tools.

### Phase A4 — Jobs, task control, worker lifecycle and real presence

**Goal.** Group tasks into jobs, let Human pause, resume and cancel them, close task-bound workers automatically, and know whether each worker is alive.

**Design.**

- Table `jobs` (migration): `id`, `project_id`, `brain_id`, `origin_message_id` (the Human request), `title`, `state` (`active`, `paused`, `done`, `cancelled`), timestamps. Brains create one with `job_event {type:"open", title, originMessageId}` or implicitly with `request_worker {job:{title}}`; tasks get an optional `job_id`. A job is done when all its tasks are finished; Human can close it.
- Task states added: `paused` with `pauseMode` (`soft`/`hard`). Human actions (UI API): **Pause soft** (control message: checkpoint, then stop and wait), **Pause hard** (control message asking for a checkpoint, then after a grace period a `kill` launcher command; for fixed workers only soft is offered unless their session is known), **Resume** (soft: control message; hard: a launch request for the same identity with `resume=Name` and its handoff, subject to the brain's mode), **Cancel** (task `cancelled` with Human as actor, then close and archive a task-bound worker; a fixed worker gets a control message). The brain is notified of each as a task event.
- Worker lifecycle: when a task-bound worker's task becomes `accepted_complete` or `cancelled`, enqueue `kill` and archive the identity (`archived` label in history, like the removal tombstone but without cancelling anything).
- Real presence (was Phase 1, #258): activity state `ready | working | stalled | offline | superseded` with `since`, from wait bursts, recent actions and queued mail; published on the snapshot and `agent` events. A launched worker that never claims its identity, or that stalls, is surfaced on its task and to its brain. No automatic relaunch.

**Acceptance.** State machine and transitions tested, including #258 (heartbeats continue, waits stop, mail queues → `stalled`); pause/resume/cancel end-to-end with a fake launcher; automatic archive on completion.

**Implementation decisions (2026-09-27).** [Jobs and task control](task-orchestration.md) documents migration 36,
private job ownership, the durable 30-second hard-pause grace, explicit same-identity resume and activity observations.
Phase T #275 is merged into this feature branch so downstream views use its actual traffic counters. The new activity
projection fixes the visibility gap in #258 without changing native host timeout behavior or automatically relaunching agents.

### Phase A5 — Task views and talking to the brain

**Goal.** See every job and task with its progress, and act on them.

**Design.**

- **Tasks** entry per project in the sidebar and an **All tasks** view across projects (project rail / top bar), also on iPhone.
- Grouped by job: title, brain, state, counts. Each task: objective, worker and template, state chip, progress (latest checkpoint: completed steps, open questions, next action, age), bytes consumed (Phase T counter), terminal link, and actions **Pause soft / hard**, **Resume**, **Cancel**, **Open thread**, **Message brain**.
- **Requests** section with pending launch approvals (same cards as A2).
- Talking: **Open thread** posts in the task thread (the brain, as assigner, and the worker are woken as task participants); **Message brain** opens the brain's DM with the task referenced (`Task <id>` link).
- Built on `agentRuntime` (Phase 0) and realtime task/job events.

**Acceptance.** UI tests for grouping, progress and every action's request; accessibility checks as in the existing UI suites; works in Hivemind.app and the iPhone/iPad app.

### Phase 3 — Agent panel and identity editing (reduced)

Agent panel for fixed and task-bound agents (identity, template, session, activity state, current task, queue, bytes, lifecycle log, actions), Remove with an impact preview, and Human identity editing (rename with the old name kept as a resume alias, focus, seniority, capability card) with control messages telling the agent to reread `whoami`. See #271.

### Phase T2 — Role-scoped MCP tool sets

Workers should not receive brain-only tools (now including `worker_templates`, `request_worker`, `release_worker`, `job_event`). Register tools per role after `join` with `tools/list_changed`, or from a role passed at MCP start; fall back to every tool on hosts without support. See #273.

### Superseded phases

| Old phase | Now |
| --- | --- |
| 1 — Real presence and stall signalling (#269) | Part of A4 |
| 2 — Launch profiles, pre-assigned identity, per-agent resume/restart (#270) | A1 (templates replace per-agent profiles; pending identities) and A2 (launcher); per-agent Resume/Stop for fixed agents moves to Phase 3 |
| 4 — Brain delegation (#272) | Part of A3 |

## Protocol-change checklist

For any change to what agents receive (tool text, schemas, wait payload, standing orders, control messages):

1. Update `src/shared/standing-orders.ts`, `src/mcp/tool-text.ts` (400-character budget per tool) and `src/shared/agent-rules.checklist.ts`; keep `src/shared/agent-instructions.unit.test.ts` green.
2. Update [Agent connection](agent-connection.md), [Inbox delivery protocol](../DELIVERY-PROTOCOL.md), [Task protocol](../TASK-PROTOCOL.md) as relevant.
3. Use a Conventional Commit (`feat(mcp)!:` when breaking) so release-please records it in the CHANGELOG, with a note to restart every agent's MCP client and, when orders change, to call `whoami` with `orders=true`.
4. Run `npm run check` and `npm run test:coverage` in the development checkout only.

## Measuring

Standing-order and tool-text sizes can be measured without installing dependencies:

```ts
// /tmp/hm-measure.mts — run with: node --experimental-transform-types --no-warnings /tmp/hm-measure.mts
import { standingOrders } from "<repo>/src/shared/standing-orders.ts";
import { TOOL_DESCRIPTIONS } from "<repo>/src/mcp/tool-text.ts";
const base = { id: "x", name: "Forge", focus: "frontend", online: true, lastSeenAt: 0, createdAt: 0, projectId: "p", project: "acme" };
console.log(standingOrders({ ...base, role: "worker", seniority: "senior" } as any).length);
console.log(standingOrders({ ...base, name: "Atlas", role: "brain", seniority: null, focus: "coord" } as any).length);
console.log(Object.values(TOOL_DESCRIPTIONS).reduce((n, d) => n + d.length, 0));
```

Phase T adds a server-side per-agent byte counter, which replaces this for live measurements.

## Issues

Tracking issue: #274. Each phase issue is self-contained and repeats its section of this document.

| Phase | Issue |
| --- | --- |
| T — Token efficiency quick wins | #267 (implemented in #275) |
| A1 — Worker templates and task-bound identities | #276 |
| A2 — Launcher in Hivemind Server.app | #277 |
| A3 — Brain tools and per-brain mode | #278 |
| A4 — Jobs, task control, worker lifecycle and real presence | #279 (includes #258) |
| A5 — Task views and talking to the brain | #280 |
| 3 — Agent panel and identity editing | #271 |
| T2 — Role-scoped MCP tool sets | #273 |
| 0 — Foundations (folded into A1/A4/A5) | #268 |
| Superseded | #269, #270, #272 |
