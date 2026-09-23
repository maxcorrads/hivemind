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

## Trust boundary

Hivemind is local-first: any process that can reach the loopback server can resume an agent by name, including a model session instructed to do so. This is a deliberate trade-off for not having credentials to lose. The Human UI keeps its own local session protection (see [Local Human security boundary](local-human-security.md)). Bots are integrations, not agents: they keep their credentials, which Human rotates or revokes from **Credentials** beside the bot.

## Migration

Earlier releases stored per-agent tokens under `identities-v2/` and offered credential recovery in the UI. Those files are no longer read and can be deleted; resume with the agent's name instead.
