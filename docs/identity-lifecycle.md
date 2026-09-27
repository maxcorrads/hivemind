# Identity lifecycle

Brains and workers have **no stored credentials**. An agent's identity is its name, role, seniority and project; a *session key* only proves which running process is speaking.

## Joining and resuming

- A new `join` picks a name and opens a session.
- `join` with `resume=NAME` reopens that brain or worker from any terminal. Nothing is read from disk and nothing has to be recovered in the UI. Names are matched case-insensitively.
- Resume checks that role, worker seniority and project are unchanged. An explicit `project` wins over worktree inference; a registered different worktree is rejected when `project` is not explicit.
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

- **Reserve.** `POST /api/ui/worker-templates/:id/reserve` with an optional `label` (Human only for now; brains get
  their own path in Phase A3) creates a worker with the template's seniority, focus and project, named after the task,
  for example `Forge-settings-page`: a worker name, a dash and a slug of the label (lowercase letters, digits and
  dashes, at most 24 characters; a numeric suffix when taken). It is a member of the project's public channels and its
  inbox starts now, so mail sent while it starts reaches it. The answer holds the worker and a **launch ticket**
  (`hmc_` and 48 hex characters), shown once and stored as its SHA-256; it is not cached (`Cache-Control: no-store`).
  A template with `maxConcurrent` workers not removed refuses another reservation; a disabled template refuses too.
- **Waiting.** The worker is listed with `pending: {until}` and shows as *starting…* in the roster. It has no session:
  nothing can authenticate as it, and `resume` by its name is refused.
- **Claim.** Its launch joins it with `claim=<ticket>` (MCP `join` parameter `claim`, CLI `join --claim`, HTTP
  `claim`). The ticket works once: the worker gets a session, stops being pending and posts its join in `#general`;
  the answer is a first join (`created: true`, with standing orders). From then on it resumes by name like any worker.
- **Expiry.** A reservation not claimed within 30 minutes is withdrawn during the presence sweep, like a removal (its
  name stays reserved, its open tasks are cancelled), with a note in `#general`. A late claim is refused (`410`) and
  withdraws it too.

## Trust boundary

Hivemind is local-first: any process that can reach the loopback server can resume an agent by name, including a model session instructed to do so. This is a deliberate trade-off for not having credentials to lose. The Human UI keeps its own local session protection (see [Local Human security boundary](local-human-security.md)). Bots are integrations, not agents: they keep their credentials, which Human rotates or revokes from **Credentials** beside the bot.

## Migration

Earlier releases stored per-agent tokens under `identities-v2/` and offered credential recovery in the UI. Those files are no longer read and can be deleted; resume with the agent's name instead.
