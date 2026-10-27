# Remote hosts (design)

> [!NOTE]
> This is a design, mostly not shipped yet. The [Plan](#plan) lists the changes
> that build it and marks the ones shipped; so far the
> [agent listener](#agent-listener) (step 1) and
> [Attachments of any type](#attachments-of-any-type) (step 6) exist, and nothing
> turns the listener on yet.

A **remote host** is a second Mac on the local network, reached with SSH, where
Hivemind runs brains and workers. Everything else stays on the Mac that runs
Hivemind Server.app (the **control Mac**): the server and its database, the
Human UI, the accounts and their policy, the launcher queue and every decision.
The remote host only executes: it has a tmux server with the agents, their CLIs
and logins, the project clones, and a Hivemind MCP that talks to the control
Mac's server through the SSH connection.

```text
Remote host (no Hivemind UI, no server)          Control Mac
+--------------------------------------+         +-------------------------------------------+
| tmux -L hivemind                     |  SSH    | Hivemind Server.app                       |
|   agent CLI (codex, claude, agent)   |         |   terminal broker  --ssh-->  remote tmux  |
|   hivemind MCP                       |         |   host connection (one ssh per host)      |
|     -> 127.0.0.1:<agent port> -------+=========+--> agent listener 127.0.0.1:<agent port>  |
|   extra forwards (user-defined) -----+=========+--> wherever the user points them         |
| project clones at the same paths     |         |   Node server 127.0.0.1:7420 (Human UI)   |
+--------------------------------------+         +-------------------------------------------+
```

## Goals and non-goals

Goals:

- Launch, resume, list, attach and stop brains and workers on a remote host from
  the control Mac's Hivemind.app, the same way as local ones.
- Reuse the control Mac's accounts and account policy for remote launches.
- Need nothing on the remote host but SSH, the CLIs and their logins: Hivemind
  installs and updates what it needs there itself.
- Keep the control Mac's server reachable only from loopback, and give a remote
  host the agent API only, never the Human API.

Non-goals:

- A Human UI or a second server on the remote host.
- Hosts outside the local network, or SSH through jump hosts, in the first version
  (an `~/.ssh/config` entry can still add them).
- Copying CLI logins or tokens between machines (see [Accounts](#accounts)).
- Moving a running agent between hosts. Resuming it on another host is a new launch
  with a copied conversation, as between account homes today.

## Compatibility

Remote hosts are opt-in. With no host configured, nothing changes: no agent
listener, no SSH connection, no Host field (or only "This Mac"), and launches,
Resume, terminals, accounts and usage follow today's local paths exactly. Every
change in the [Plan](#plan) has a test that a hive without hosts behaves as
before.

## Hosts

A host is configured in Hivemind Server.app on the control Mac and stored there
only, like accounts: `~/Library/Application Support/Hivemind/hosts.json`, 0600.
It never reaches the repository, the server database or the page beyond its label.

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier. |
| `label` | What the UI shows, for example "Build Mac". |
| `ssh` | The SSH destination as `ssh` takes it: `user@host.local`, or a `Host` alias from `~/.ssh/config`. |
| `forwards` | Extra forwards added to the host connection, in `ssh` syntax (`-R 1080`, `-L 5432:db.internal:5432`). Hivemind does not interpret them. |

The control Mac's server knows hosts by `id` and `label` only. They come from
Server.app's launcher channel, the same way the account catalog reaches it today.

**Requirements on the host.** macOS, SSH key login without a password
(`BatchMode=yes` must succeed), a known host key in the control Mac's
`~/.ssh/known_hosts`, and Full Disk Access for Remote Login when projects live in
a protected folder (`~/Documents`, `~/Desktop`, `~/Downloads`): processes started
by `sshd` are otherwise refused there.

## Host connection

Server.app keeps one SSH connection per host while the server runs:

```text
ssh -N -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes -o ControlMaster=yes -o ControlPath=<private socket> \
    -R 127.0.0.1:<remote agent port>:127.0.0.1:<agent port> <forwards…> <ssh>
```

- **One master.** Every other SSH action (launch, list, attach, kill, file copies)
  reuses it through `ControlPath`, so each one is a new channel, not a new login.
- **Supervised.** If it exits, Server.app opens it again with backoff and marks the
  host offline meanwhile. Launches to an offline host are refused with that reason.
  Running agents keep running in the remote tmux. Their MCP reconnects when the
  forward is back, as it does today after a server restart.
- **`ExitOnForwardFailure`**: if the remote port is taken, the connection fails
  loudly instead of running without its forward.

## Agent listener

> [!NOTE]
> Shipped in the Node server (plan step 1). Server.app does not turn it on yet:
> it passes `--agent-port` once hosts exist (step 2).

Today any process that reaches `127.0.0.1:7420` can open a Human session. A plain
forward of that port would give every process on the remote host the Human API.
So the Node server gets a second listener, **agent-only**:

- It binds `127.0.0.1:<agent port>` on the control Mac (default 7422), and only
  while at least one host is configured: `hivemind serve --agent-port 7422` turns
  it on, and Server.app passes that flag while `hosts.json` has a host. Without the
  flag nothing else is bound, and no environment variable turns it on.
- It serves `/api/agent/*`, which needs an agent token, including `POST
  /api/agent/join`, the unauthenticated route an agent uses to get one by name,
  resume or launch claim ticket. It also answers `GET /api/health`, the
  session-independent check `hivemind doctor` reads. Nothing under `/api/ui/*`,
  `/api/launcher/*`, `/api/bot/*`, `/api/health/instance`, `/ws` or the static UI is
  reachable through it: those, and every other path, answer 404 with
  `{"error":"Not found"}`.
- Two layers keep it that way. The listener classifies the decoded path before the
  ingress gate (`isAgentListenerPath` in `src/server/local-auth.ts`), so no Human
  path is handled at all there, not even the session bootstrap; dot segments and
  encoded slashes count as not allowed. Then its router (`createApps` in
  `src/server/app.ts`) has only the agent routes and the health check mounted.
  The agent routes are the same ones, on the same Hive, as on the Human listener.
- Agent requests on it pass the same Host, Origin and Fetch Metadata checks as on
  the Human listener, so a browser on the remote host cannot drive it either.
- If the agent port is taken, `serve` fails to start (`EADDRINUSE`), as it does
  for a taken Human port.
- The host connection forwards the remote loopback port to it. On the remote
  host, agents use `HIVEMIND_URL=http://127.0.0.1:<remote agent port>`.

The MCP needs no change: its client takes any `HIVEMIND_URL` that is a plain
origin (`identityOrigin` in `src/client/identity.ts`), and on the remote host that
origin is loopback too. Bots keep using the Human listener's origin: the server
hands them that one (and checks it with `localOrigin`) even when a brain calls a
bot tool through the agent listener.

## Remote runtime

Server.app installs what the MCP needs on each host, in
`~/Library/Application Support/Hivemind/remote/<version>/` there: its own bundled
Node.js and the server package, the same files as its own `Contents`. It checks the
version at every connection and replaces it when the control Mac updates, so the
MCP on a host always matches the server. The copy goes over the master connection
(`tar` on stdin). A host needs no Node.js or Hivemind install of its own.

The `hivemindMcp` of a launch context gains a per-host variant: the remote runtime's
`node` and `cli.js mcp`, with the remote `HIVEMIND_URL`.

## Launch

The Launch sheet, Resume… and worker templates get a **Host** field: this Mac
(the default), or one of the configured hosts. The server records the host on a
launch request; the launcher channel carries it to Server.app; the broker picks
the transport.

A launch on a host does what the broker does locally, over SSH:

1. **Session name and locks.** Names stay `hm-<project>-<agent>`, unique across
   hosts: the broker checks every host before choosing. The one-writer checks for
   Codex threads and Claude sessions run on the host that owns the conversation.
2. **Workspace.** The project's path is the same on every host. If it is missing,
   the broker clones it there first, from the control Mac's
   `git remote get-url origin`, and stops with the clone's error if that fails.
   Credentials for the clone are the host's own (an SSH key or `gh auth login`
   there).
3. **Account.** Resolved on the control Mac as today. Its home exists on the host
   at the same path (see [Accounts](#accounts)). Shadow homes are prepared on the
   host by the same `ShadowHome` steps, run there.
4. **Launch file.** The variables and secrets go to the host on SSH stdin, written
   to a 0600 file under `~/Library/Application Support/Hivemind/launch-secrets/`
   there with `O_EXCL`. They never appear on a command line. The tmux script loads
   and deletes it exactly as it does locally.
5. **tmux.** The same `TmuxCommand` invocation, run on the host with its own
   `tmux.conf`, which Server.app installs with the runtime.
6. **Claude status-line tap.** Installed on the host. Its `statusline.json` and
   `limit-error` are read back over SSH by the usage probe (see [Usage](#usage)).

## Sessions and terminals

- **List.** The broker polls `tmux -L hivemind list-sessions` on each online host
  alongside the local one, and tags every session with its host. Session events
  and the Sessions sheet show the host label.
- **Attach in the app.** The broker runs `ssh -tt <master> tmux -u -L hivemind
  attach-session -t =<name>` under `forkpty` instead of local `tmux attach`.
  Output and input frames are unchanged, so Hivemind.app's terminal view works as
  it does today.
- **Open in Terminal.** The `.command` file runs that `ssh -tt …` line.
- **Stop and kill.** `kill-session` on the session's host.

## Accounts

Remote launches use the control Mac's accounts: the same entries, policy and
pins. Each account's home exists on every host at the same path (`~/.claude2`,
`~/.codex3`, …), logged in once **on that host** by the user to the same provider
account. Hivemind copies no login and stores no token.

- **Setup.** For each account and host, Server.app creates the home with the
  control Mac's configuration: settings, skills, plugins, and the Codex
  `config.toml` with its `[mcp_servers.hivemind]` block pointing at the remote
  runtime. It copies no credential file (`auth.json`, `.credentials.json`) and no
  `.claude.json`. The Accounts sheet then lists, per host, the homes that still
  need a login and the command to run there.
- **Same account check.** Before the first launch of an account on a host, and
  after each login, Server.app compares the account identity on both sides without
  reading a token: Codex `account/read` from `codex app-server` (the plan account),
  Claude `oauthAccount.accountUuid` in the home's `.claude.json`. A mismatch or a
  missing login refuses the launch and names the host, the home and the account.
- **Cursor.** `agent login` on the host, once.

Sharing a refresh token between two machines would let each one invalidate the
other's when it rotates, which is why logins happen on each host.

## Usage

- **Codex.** Unchanged: the same account reports the same windows on every host,
  and the control Mac already reads them.
- **Claude.** The tap writes on the host where the session runs. The usage probe
  reads each host's `statusline.json` and `limit-error` over the master connection
  and keeps the newest per account.

## Conversations

**Find last conversations** scans each host's transcripts as it scans the control
Mac's (docs/terminal-broker.md#resuming-conversations), over SSH, and returns the
host with each conversation. Resuming on another host than the conversation's
needs a copy of its files first, like a copy between account homes today.

## Security

- **A host can run anything as the user**, and so can whoever controls it. Add only
  machines you own.
- **The remote host gets the agent API only**, through the agent listener. Any
  local user of the remote host can reach that forward, so a host should have one
  user, or the forward should stay off while others are logged in.
- **SSH** uses keys and the control Mac's `known_hosts`. An unknown or changed host
  key refuses the connection, with no prompt.
- **Extra forwards** are the user's. Hivemind adds them to the connection and does
  nothing else with them.
- **Launch secrets** travel only inside the SSH channel and land in a 0600 file
  that the session deletes on start.

## Limits

- The control Mac must be awake and running Server.app for remote agents to reach
  Hivemind. Agents keep running without it, but their calls fail until it is back.
- One SSH round trip per broker action, about tens of milliseconds on a LAN; the
  session list is polled less often for remote hosts (5 s).
- macOS hosts only, in the first version.

## Attachments of any type

**Shipped**, independent of hosts. An attachment used to be one of nine types
(PNG, JPEG, WebP, GIF, PDF, plain text, CSV, JSON, ZIP), because files were served
inline from the Human UI's origin, where an HTML or SVG file would run its script
with the Human's powers. Now any type is stored and only a safe list is served
inline (`INLINE_MIMES` in `src/shared/mime.ts`).

- **Upload.** Any type is accepted, with the current limits (512 MB per file, the
  8 GiB quota, at most 4 per message) and `attach`'s refusal of sensitive files
  (keys, `.env*`, `~/.ssh`, …). The stored type is the sender's `X-File-Mime` when
  it is a well-formed `type/subtype` (lowercased, parameters dropped), otherwise a
  guess from the file name, otherwise `application/octet-stream`. Telegram
  documents of any type are accepted the same way.
- **Preview.** Only a safe list renders inline: PNG, JPEG, WebP and GIF (not SVG),
  PDF and plain text. In the Human UI raster images show as images, PDF and text as
  a chip that opens them, and everything else as a chip with its name, size and
  Download.
- **Download.** A type outside the safe list is served as
  `application/octet-stream` with `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox; frame-ancestors 'none'`, so a browser or
  WebView saves it and never runs it. Safe types are served as before, inline under
  their own type and without the sandbox (Chromium's PDF viewer does not render a
  sandboxed PDF). Every download carries the stored type in `X-File-Mime`, and the
  message API reports it, so agents still see the sender's type.
- **Agents.** `attach`, `fetch_file` and `hivemind send --file` take any type, with
  the same sensitive-file filter (`hivemind send --file` used to refuse unknown
  extensions and now applies `attach`'s filter instead).

## Plan

1. **Agent listener** (shipped). The agent-only listener in the Node server, behind
   `hivemind serve --agent-port`. Tests: `src/server/agent-listener.test.ts`.
2. **Hosts and the host connection.** `hosts.json`, the supervised master
   connection with the agent forward and extra forwards, host status in the
   Server.app menu, and the remote runtime install and update. Server.app starts
   `serve` with `--agent-port` while at least one host exists.
3. **Launch on a host.** The Host field in Launch, Resume… and templates, the host
   on launch requests and the launcher channel, the remote launch steps (clone,
   shadow homes, launch file, tmux, tap), remote session listing and kill.
4. **Terminals.** In-app attach and Open in Terminal for remote sessions.
5. **Accounts on hosts.** Home setup, the same-account check, the Accounts sheet's
   per-host status, remote usage reads, and Find last conversations per host.
6. **Attachments of any type** (shipped). The upload allowlist removed, the safe
   preview list, and download headers for every other type.
