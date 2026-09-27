# Agent management and token efficiency roadmap

Status: planned, not started. Written on 2026-09-27 against `8f0e583` (#265).

This document is the single source of truth for a multi-phase effort to improve how Hivemind manages brains and workers, in the UI and in the server/MCP logic, and to reduce the tokens agents spend. It is written so that work can resume from here alone, without the conversation that produced it. Each phase has its own GitHub issue; the tracking issue lists them all (see [Issues](#issues)).

## How to resume work

1. Read [Decisions](#decisions) and [Development safety rules](#development-safety-rules) first.
2. Open the tracking issue and pick the first unchecked phase. The recommended order is the order of [Phases](#phases).
3. Each phase section lists its goal, the files involved, concrete steps, acceptance criteria and risks. Its issue repeats the same content; if they diverge, update both.
4. When a phase changes what agents receive (MCP tool text, wait payloads, standing orders), follow the [protocol-change checklist](#protocol-change-checklist).
5. Tick the phase in the tracking issue and update the **Status** line at the top of this document when a phase is merged.

## Goals

- Show what each agent is really doing (ready, working, stalled, offline), not only whether its MCP process is alive.
- Make launch, resume and restart per agent, reproducible from any device (Mac and iPhone/iPad), with the launch configuration stored on the server.
- Make the agent ↔ tmux session link reliable, without heuristics.
- Give the Human one place to see and act on an agent, including editing its identity.
- Give brains enough information to delegate to a free worker.
- Reduce the tokens agents spend on Hivemind traffic, and measure it.

## Decisions

Taken by Human on 2026-09-27. Do not reopen them without a new Human decision.

| Topic | Decision |
| --- | --- |
| Platforms to optimize for | Hivemind.app on the Mac and the iPhone/iPad app (both have terminals through the broker). The plain browser keeps working but is not the design target. |
| Typical scale | 1–3 agents per project. Prefer a rich per-agent view over roster grouping and bulk actions. |
| Auto-resume | **Never.** Mail for an offline agent whose session ended is only signalled in the UI. The principle "agents never open themselves" stays. |
| Launch configuration on the server | **Yes.** Software, model, effort, focus, workspace and non-secret environment variables are stored per agent in the local database. Secrets (the OpenCode Go API key) are never stored. |
| Identity editing by Human | Human may choose the name at launch and rename, change focus, change seniority and edit a worker's capability card. |
| Work order | Token quick wins first (Phase T), then foundations, presence, launch, agent panel, brain delegation, role-scoped tools. |

## Development safety rules

Human runs a production Hivemind while this work happens. Nothing done for this roadmap may disturb it.

- **The running setup lives in another checkout.** Hivemind Server.app, Hivemind.app and every agent's `hivemind mcp` process run from `~/Documents/develop/hivemind` (server on `127.0.0.1:7420`, state in `~/.hivemind`, tmux server `-L hivemind`). Development happens in a separate checkout, `~/Documents/develop/hivemind-dev/hivemind`. Never edit, build, install or run anything in the production checkout.
- **Never bind 7420 or 7421.** Do not run `npm run dev`, `npm start`, `browser:server` or the coordination benchmarks' live executor (it uses port 7420) from the development checkout while the production server runs. The unit and integration suites start their own servers on ephemeral ports and are safe.
- **Never touch `~/.hivemind`.** Any manual server run uses a throwaway home and a free port, for example `HIVEMIND_HOME=$(mktemp -d) npx tsx src/cli.ts serve --port 7520` (`HIVEMIND_PORT` also works). The instance lock is per home, so a separate home never conflicts with the production server.
- **Never touch the production tmux server** (`tmux -L hivemind`) or `~/Library/Application Support/Hivemind/`.
- **Migrations.** Phases 1–3 add SQLite migrations. They apply to `~/.hivemind` the first time Human runs the new code in production. Call this out in each PR, and remind Human to back up `~/.hivemind` with every server stopped before upgrading (see [Storage, backup and restore](storage-and-backup.md)).
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

## Phases

Recommended order: T → 0 → 1 → 2 → 3 → 4 → T2. Phase T is independent. Phases 1–4 build on Phase 0.

### Phase T — Token efficiency quick wins

**Goal.** Cut the bytes Hivemind returns to agents without changing semantics, and start measuring them.

**Steps.**

1. Compact JSON in MCP tool results: `text()` in `src/mcp/index.ts` uses `JSON.stringify(data)`. Update `waitWireBytes` in `src/server/wait-format.ts` to budget the compact MCP form, keeping the budget honest for the HTTP JSON and CLI forms (the CLI may keep pretty output for people; check `src/cli.ts`).
2. Send a task contract once per mail item: in `packWait`, keep `taskEvent` and replace `body` for task events with a short header (task id, action, revision, contract version), or keep `body` and drop the contract from `taskEvent`. Pick one and document it in [Inbox delivery protocol](../DELIVERY-PROTOCOL.md) and [Task protocol](../TASK-PROTOCOL.md). History and the UI keep the full rendered body.
3. Send `you` and `next` only when needed: on the first wait of an inbox session and whenever `you` changes (resume, identity edit). Standing orders and the `wait` tool description must still say what to do after mail (ack, reply, wait again).
4. Remove fixed disclaimers from `taskBody` where the standing orders already hold the rule. Keep one short phrase per action only where it changes behaviour.
5. Measure: count, per agent, the bytes Hivemind returned through wait and other tool results (a per-agent counter on the server, grouped by tool, reset with retention). Expose it on the Human snapshot for Phase 3's agent panel. Record a before/after baseline with the storage/coordination benchmarks' fixtures (not live providers).

**Files.** `src/mcp/index.ts`, `src/server/wait-format.ts`, `src/shared/tasks.ts`, `src/shared/types.ts` (`WaitResult`, `WaitMailItem`), `src/server/services/delivery.ts`, tests in `src/mcp/*.test.ts`, `src/server/inbox-bounds.test.ts`, `src/shared/agent-instructions.unit.test.ts`, `src/shared/agent-rules.checklist.ts`.

**Acceptance.** All tests green (`npm run check`, `npm run test:coverage`). Wait pages carry at least as many messages as before under the same 64 KiB cap. A recorded baseline shows the byte reduction. Docs updated.

**Risks.** Agents parse fields by name: renaming or removing fields is a protocol change (restart MCP clients). Hosts that display raw tool output get less readable text; that is acceptable.

### Phase 0 — Foundations

**Goal.** One place computes an agent's runtime state, one source delivers it, and the Launch sheet becomes maintainable. No visible behaviour change.

**Steps.**

1. Add a pure selector, for example `web/agent-runtime.ts`: `agentRuntime(agent, snapshot, terminals, work)` returning `{ presence, session, sessionStatus, attention, statusLine }`. Move into it the logic now in `agentStatusLine` (`nav-model.ts`), `agentLiveSession`/`recordedSession` (`use-terminal.ts`), `sessionOwner`/`sessionStatus` (`SessionsSheet.tsx`) and the `hadTerminal` handling in `ChannelDesk.tsx`. Use it from `AgentList`, `DmTitle`, `ChannelDesk` and `SessionsSheet`.
2. Deliver agent work together with presence: include `agentWork` in the snapshot and in `agent`/`task` realtime events (or a single `agentView` event), and retire the separate `/api/ui/nav-status` polling in `use-nav-status.ts`.
3. Split `LaunchSheet.tsx`: a `useLaunchForm` hook (reducer plus persistence, replacing the manual `remember()` patches) and components for the new-agent form, the resume list and the advanced options. Keep the `localStorage` format readable until Phase 2 moves it to the server.

**Acceptance.** Existing UI tests pass unchanged or with mechanical updates (`web/terminal.unit.test.tsx`, `web/terminal-session-map.unit.test.tsx`, `web/nav-rows.unit.test.tsx`, `web/bots.test.tsx`). New unit tests cover `agentRuntime`. No change in rendered output.

### Phase 1 — Real presence and stall signalling

Related: #258.

**Goal.** Show whether an agent is ready, working, stalled or offline, and warn Human when an agent is probably stuck. Never relaunch anything automatically.

**Steps.**

1. Server-side activity state per brain/worker: `offline | ready | working | stalled | superseded`, with `since`.
   - `ready`: a wait is in flight, or the last wait burst ended less than a grace period ago (bursts are 20 s).
   - `working`: no wait for longer than the grace period, but the agent made requests recently (send, task_event, ack…), or a delivery was offered and acknowledged.
   - `stalled`: no wait for longer than a threshold (for example 3 minutes) while mail is queued or a delivery awaits receipt. This covers #258.
   - `offline`: no requests for `PRESENCE_IDLE_MS`, or `leave`. Consider a shorter "disconnected" detection when bursts stop and heartbeats stop.
   - `superseded`: a newer session of the same name exists (transient).
   Store what is needed (for example `last_wait_at`, `last_action_at`) in a migration; publish the state on the snapshot and on `agent` events. Keep `online` for compatibility.
2. UI: show the state and "since" in the roster status line and the DM header, through `agentRuntime`.
3. Stall hint in the apps (computed in the page, the server runs nothing): if the agent's tmux session is alive, the agent is `stalled` or has not waited for N minutes, and mail is queued, show "Probably waiting at a prompt in its terminal" with **Open terminal**, and a native notification (see [Targeted notifications](../NOTIFICATIONS.md) and `web/desktop-notifications.ts`).
4. Offline with mail: when mail is queued for an offline agent whose session ended, show it in the roster and agent panel with **Resume** (Phase 2). No automatic launch.

**Acceptance.** Unit tests for each state transition, including the #258 scenario (heartbeats continue, waits stop, mail queues → `stalled`). The roster shows the state. No command is ever run without a Human click.

**Risks.** Hosts differ in how long a turn takes; thresholds must be conservative and documented. The state is a hint, not authority (same wording as the rest of Hivemind).

### Phase 2 — Launch profiles, pre-assigned identity, per-agent resume and restart

**Goal.** Launch, resume and restart any single agent the same way from the Mac or the iPhone, with a reliable agent ↔ session link.

**Steps.**

1. Launch profile per agent on the server: software, model, effort, extra flags, focus, workspace path, non-secret environment variables (same rules as `src/shared/launch-environment.ts`). New table via migration; Human-only API (`/api/ui/...`). Never store `OPENCODE_API_KEY` or any secret. The Launch sheet reads and writes profiles instead of `localStorage` (migrate existing `localStorage` values on first open, per browser).
2. Project-level defaults per role and seniority (for example a cheaper model for junior workers or reviewers), used when an agent has no profile yet.
3. Pre-assigned identity: Human reserves the name before launching (a "pending" agent row: no session, not in the roster as online, not visible to agents). The broker session is created as `hm-<project>-<name>` from the start. The prompt joins by claiming that name (a new `join` field, or `resume` accepting a pending identity). A pending identity never joined within a time limit can be discarded. This removes `hm-<project>-new-<n>`, "Waiting to join" and the dependency on Codex `env_vars` for mapping. Human may choose the name at launch (validated like generated names, unique, case-insensitive).
4. Per-agent actions in the apps: **Resume** (launch with `resume=Name` and the stored profile; reuses the running session if any), **Stop** (kill its tmux session after confirmation; the agent stays in the hive), **Restart** (ask the agent for a checkpoint on its active tasks, kill the session, resume with handoffs). Restart gives the CLI a genuinely fresh context, which `clear_context` cannot, and is the main context-rotation tool for long sessions.
5. Keep the copy-command flow for the browser, built from the same profile.

**Files.** `src/server/migrations/*`, `src/server/services/identity.ts`, `src/server/app.ts`, `src/shared/launch-prompt.ts`, `src/shared/api-contract.ts`, `web/LaunchSheet.tsx` (after Phase 0), `web/use-terminal.ts`, `web/native-bridge.ts`, docs [Identity lifecycle](identity-lifecycle.md), [Agent connection](agent-connection.md), [Terminal broker](terminal-broker.md), [macOS apps](macos.md), [iOS](ios.md).

**Acceptance.** Resuming an agent from the iPhone uses the same software/model/env as from the Mac. A newly launched agent's session is named after it before it joins. Restart produces a new session with handoffs and no lost mail. Secrets never reach the database (test it).

**Risks.** Pre-assigned identities add a new identity state: every query that lists agents must exclude pending ones where appropriate (roster, mentions, delivery, Jev capacity). The broker protocol is unchanged if the page passes the reserved name as `agent`.

### Phase 3 — Agent panel and identity editing

**Goal.** One place to see and act on an agent; Human can edit its identity.

**Steps.**

1. Agent panel: a side panel (like `ThreadAside`) or an **Overview** tab in the agent's DM. Contents: name, role, seniority, focus, project; software/model from the profile; tmux session and its state; activity state and since (Phase 1); current task with its latest checkpoint and next action; queue and receipts; bytes returned to it (Phase T); capability card; lifecycle log; actions (Open terminal, Resume, Restart, Stop, Clear context, Edit, Remove).
2. Lifecycle log: an append-only table of joined, resumed, superseded, went offline, stalled, session ended, context cleared, identity edited, removed; bounded by the existing retention (`src/server/maintenance.ts`).
3. Remove with an impact preview: a read-only endpoint returning the tasks that would be cancelled and the tasks that would lose their reviewer, shown in the confirm sheet, with an option to stop the agent's tmux session too.
4. Identity editing (Human only):
   - **Focus**: editable; the agent is told through a control message to reread `whoami` with `orders=true`.
   - **Seniority**: editable for workers. Update `assertResumable` (a resume must accept the stored seniority, not an old one from a copied prompt), the standing orders line "Your identity is fixed", and launch prompts.
   - **Name**: rename keeps the old name reserved as an alias for resume and history; mentions of the new name work immediately; the tmux session keeps its name until the next launch; the running agent gets a control message with its new name.
   - **Capability card**: Human can edit any worker's card (today only the worker can, `RoutingStore.set`). Record who changed it.
5. Allow Clear context for brains from the UI if Human wants it (today the roster offers it only for workers).

**Acceptance.** Every action has a confirm where destructive, and tests for authorization (only Human), for rename/resume aliasing and for the control messages. Standing orders and the rules checklist updated.

**Risks.** Renaming touches mentions (`src/shared/mentions.ts`), DM channel names, Telegram topics and the tmux session label. List and test each.

### Phase 4 — Brain delegation

**Goal.** Brains pick a free worker without guessing.

**Steps.**

1. Enrich `GET /api/agent/agents` (MCP `agents`) for brains with each worker's activity state (Phase 1), the number of unfinished tasks it holds and an approximate queue count, within the project. Workers keep the current minimal view.
2. Mention in the brain standing orders that the roster shows availability, briefly.
3. Show the capability card in the agent panel (Phase 3) and suggest filling it at launch (Phase 2 profile can pre-fill model/host).

**Acceptance.** Tests for scoping (no cross-project data, workers do not see others' workload). Tool description stays within the 400-character budget.

### Phase T2 — Role-scoped MCP tool sets

**Goal.** Workers do not see brain-only tools and their schemas.

**Steps.**

1. Check which hosts support `notifications/tools/list_changed` (Claude Code, Codex, Cursor, OpenCode). Record the versions tested.
2. Option A: after `join`, register only the tools for the agent's role and send `tools/list_changed`. Option B: pass the role at MCP start (for example `HIVEMIND_ROLE`, set by the launch command, and listed in Codex `env_vars`) and register only that role's tools from the start. Keep a safe fallback: unknown role registers every tool, as today.
3. Server authorization stays unchanged (it already rejects brain-only calls from workers).

**Acceptance.** A worker's tool list excludes brain-only tools on hosts that support it; nothing breaks on hosts that do not.

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

Tracking issue and one issue per phase: filled in below once created.
