# Identity lifecycle

Brains and workers have **no stored credentials**. An agent's identity is its name, role, seniority and project; a *session key* identifies the bearer session, not a physical process.

## Joining and resuming

- A new `join` picks a name and opens a session.
- `join` with `resume=NAME` reopens that brain or worker from any terminal. Nothing is read from disk and nothing has to be recovered in the UI. Current and former names are matched case-insensitively for resume.
- Resume checks that role and project are unchanged. Human-edited seniority and focus remain authoritative; stale launch arguments cannot reset them. An explicit `project` wins over worktree inference; a registered different worktree is rejected when `project` is not explicit.
- A repeated `join` from the same running MCP process keeps its session: the process sends its current session key, so no new session is opened.

## Sessions

The server issues a session key at join. The MCP process keeps it only in memory and sends it with every request; it is never returned to the model or written to a file. The CLI prints `export HIVEMIND_TOKEN=…` for the shell that ran `join`; other terminals never inherit it.

Resuming a name opens a new session and, in the same database transaction, **supersedes** the previous one:

- the previous session key stops working;
- a `wait` in flight returns as superseded, and receipts from the old inbox session are rejected;
- unacknowledged mail is not consumed: the new session receives it again.

Old external processes are not killed; requests they already committed and external side effects are not revoked retrospectively.

## Reserved workers

A worker launched from a [worker template](worker-templates.md) exists before its process joins (roadmap Phase A1, #276):

- **Reserve.** `POST /api/ui/worker-templates/:id/reserve` with an optional `label` (Human only; brains use `request_worker`) creates a worker with the template's seniority, focus and project, named after the task,
  for example `Forge-settings-page`: a worker name, a dash and a slug of the label (lowercase letters, digits and
  dashes, at most 24 characters; a numeric suffix when taken). A Human reservation joins the project's public channels;
  a brain-requested worker sees only its task channel until claim. Its inbox starts at reservation. The answer holds the worker and a **launch ticket**
  (`hmc_` and 48 hex characters), shown once and stored as its SHA-256; it is not cached (`Cache-Control: no-store`).
  Capacity excludes requests awaiting approval and is checked again at approval/dispatch. Archived workers with uncertain
  native cleanup still consume capacity until closure is acknowledged; disabled templates refuse new launches.
- **Waiting.** The worker is listed with `pending: {until}` and shows as *starting…* in the roster. It has no session:
  nothing can authenticate as it, and `resume` by its name is refused.
- **Claim.** Its launch joins it with `claim=<ticket>` (MCP `join` parameter `claim`, CLI `join --claim`, HTTP
  `claim`). The ticket works once: the worker gets a session, stops being pending and posts its join in `#general`;
  the answer is a first join (`created: true`, with standing orders). From then on it resumes by name like any worker.
- **Expiry.** A reservation not claimed within 30 minutes is withdrawn during the presence sweep, like a removal (its
  name stays reserved, its open tasks are cancelled), with a note in `#general`. A late claim is rejected: `410` when the claim itself detects expiry and withdraws it, or `401` after the sweep
  has already cleared the ticket hash.

## Trust boundary

Hivemind is local-first: any process that can reach the loopback server can resume an agent by name, including a model session instructed to do so. This is a deliberate trade-off for not having credentials to lose. The Human UI keeps its own local session protection (see [Local Human security boundary](local-human-security.md)). Bots are integrations, not agents: they keep their credentials, which Human rotates or revokes from **Credentials** beside the bot.

## Migration

Earlier releases stored per-agent tokens under `identities-v2/` and offered credential recovery in the UI. Those files are no longer read and can be deleted; resume with the agent's name instead.

## Human identity editing and the agent panel

Human can edit an active brain or worker by id with an expected identity revision. Names are mentionable ASCII names;
name collisions include pending, removed and archived identities and every former-name alias. A former name remains
reserved for that identity's resume/history use; new mentions and new work address the current name. Renaming back to
one's own former name is allowed. Role and project do not change.

Focus and worker seniority belong to the stored identity. A later resume, ticket claim or template change must retain
Human's overrides. An edit sends a control message asking the agent to reread `whoami` with `orders=true`. Human can
also edit a worker capability card with its expected revision; the card records its last editor. A stale editor must
reload before another save.

DM channel ids and memberships stay stable while their visible labels change. Task projections use the current name;
historical message bodies retain what was actually written. Existing native terminal labels keep their old name until
the next launch. Telegram routes remain bound to channel ids; existing remote topic titles may retain the old label.
A pending launch already dispatched to a native host may also retain its original display label, while its claim ticket
still resolves to the current stored identity.

The panel combines identity, current template settings when available, current work/checkpoint, inbox, API response bytes,
native terminal evidence and lifecycle history. Current template settings are labelled separately from the running process;
they may have changed since launch. A deleted template retains only its saved label. Fixed agents have no persisted software/model profile: Resume asks
Human to choose the launch settings. Stop is an explicit native broker action, available only for a verified running
session. A missing broker connection means unknown, not stopped. Resume/Stop do not change an identity's role or
silently launch a task-bound worker outside its task controls.

Removal previews the unfinished tasks that will be cancelled and those that will lose their reviewer. Its confirmation
is bound to that impact; changes require a fresh preview. Native Stop and identity removal are separate outcomes. A
failed requested Stop remains visible and requires an explicit choice before continuing with removal.

Migration 38 adds identity revisions, Human override markers, reserved name aliases, capability editor attribution and
an append-only lifecycle log. Lifecycle retention follows the operational-log retention setting; messages and task
history remain. Server observations are distinguished from Human UI stop reports; heartbeat loss alone never proves
that a native process ended.
