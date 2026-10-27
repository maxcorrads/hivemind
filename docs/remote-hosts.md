# Remote hosts (design)

> [!NOTE]
> Partly shipped. [Hosts](#hosts), the [host connection](#host-connection) and the
> [remote runtime](#remote-runtime) (plan step 2) are in Hivemind Server.app; the
> rest is still a design, and no launch goes to a host yet. The [Plan](#plan) lists
> the changes that build it.

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

*Shipped.* The file is `{"hosts": [...]}`, written whole on every change. The
Server.app menu's **Hosts → Add Host…** takes the label, the destination and the
forwards (separated by spaces or new lines, `-R 1080` or `-R1080`), and
**Remove…** forgets a host. The `id` is a lowercase UUID; the label is 1–80
characters; the destination is one word that does not start with `-`, since `ssh`
would read it as an option; each forward is stored as its flag (`-L`, `-R` or
`-D`, nothing else) and one spec, at most 16 per host, and is passed to `ssh` as
those two arguments. At most 16 hosts. A `hosts.json` that cannot be read is
never overwritten: the menu says to move it away.

The control Mac's server knows hosts by `id`, `label` and `online` only. They come
from Server.app over the launcher channel (`PUT /api/launcher/hosts`, signed like
the usage probe's posts), as the whole catalog, sent again when a host is added
or removed, when one goes online or offline, and to every new server. The server
holds it in memory (`hive.hosts`, src/server/host-catalog.ts): it is Server.app's
state. A host is `online` when its connection is up and its remote runtime is
this version's. With no host and none sent before, Server.app sends nothing.

**Requirements on the host.** macOS, SSH key login without a password
(`BatchMode=yes` must succeed), a known host key in the control Mac's
`~/.ssh/known_hosts`, and Full Disk Access for Remote Login when projects live in
a protected folder (`~/Documents`, `~/Desktop`, `~/Downloads`): processes started
by `sshd` are otherwise refused there.

## Host connection

Server.app keeps one SSH connection per host for as long as it runs:

```text
ssh -N -o BatchMode=yes -o StrictHostKeyChecking=yes -S <private socket> \
    -o ControlMaster=yes -o ControlPersist=no \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 \
    -o ExitOnForwardFailure=yes \
    -R 127.0.0.1:<remote agent port>:127.0.0.1:<agent port> <forwards…> <ssh>
```

- **One master.** Every other SSH action (launch, list, attach, kill, file copies)
  reuses it through its control socket, so each one is a new channel, not a new login.
- **Supervised.** If it exits, Server.app opens it again with backoff and marks the
  host offline meanwhile. Launches to an offline host are refused with that reason.
  Running agents keep running in the remote tmux. Their MCP reconnects when the
  forward is back, as it does today after a server restart.
- **`ExitOnForwardFailure`**: if the remote port is taken, the connection fails
  loudly instead of running without its forward.

*Shipped* (HivemindKit's `SSHTransport` and `HostConnection`), with these
details:

- **Socket.** `-S` names the control socket as one argument (an `-o ControlPath=`
  value would split at the space in `Application Support`). It lives in
  `~/Library/Application Support/Hivemind/ssh/` (0700), named by the first 16 hex
  digits of the host id's SHA-256; when that path would not fit in a Unix socket
  address, in `/tmp/hivemind-ssh-<uid>/` (0700, refused if another user made it).
- **`ControlPersist=no`** keeps a `~/.ssh/config` default from sending the master
  to the background, out of Server.app's supervision.
- **`StrictHostKeyChecking=yes`** makes the "no prompt" rule hold whatever
  `~/.ssh/config` says: an unknown or changed host key fails the connection.
- **Up.** The master prints nothing when it is up, so Server.app asks it with
  `ssh -O check` every 0.5 s; the host is online once it answers. A master that
  does not answer within 30 s is ended and counts as a failed connection.
- **A crashed app's master.** Before each connection Server.app sends `ssh -O
  exit` on the socket, so a master an earlier run left behind gives back the
  agent forward's remote port.
- **Backoff.** 2 s, doubling to a minute, and never giving up: a host that sleeps
  or leaves the network comes back on its own. A connection that stayed up 30 s
  resets it. The menu shows ssh's last line (`Permission denied (publickey).`,
  `remote port forwarding failed …`) and the next retry; `hosts.log` has the rest.
- **Ports.** The agent port and the remote agent port are both 7422.
- **Other commands** reuse the master: `ssh -S <socket> -o ControlMaster=no -T
  <ssh> <command>`, in BatchMode too.
- **For the life of the app**, not only while the server runs, like the terminal
  broker: agents on a host keep running whatever the server does, and the
  later broker steps (list, attach, kill) need the master without the server.
  While the server is stopped the forward only refuses connections, as
  `127.0.0.1:7420` does for agents here.

## Agent listener

Today any process that reaches `127.0.0.1:7420` can open a Human session. A plain
forward of that port would give every process on the remote host the Human API.
So the Node server gets a second listener, **agent-only**:

- It binds `127.0.0.1:<agent port>` on the control Mac (default 7422), and only
  while at least one host is configured.
- It serves `/api/agent/*`, which needs an agent token, and the unauthenticated
  join and claim routes an agent uses to get one. Nothing under `/api/ui/*`,
  `/api/launcher/*`, `/ws` or the static UI is reachable through it: those answer 404.
- The host connection forwards the remote loopback port to it. On the remote
  host, agents use `HIVEMIND_URL=http://127.0.0.1:<remote agent port>`.

The MCP's own checks (`localOrigin` refuses anything but loopback) stay as they
are: on the remote host the origin is loopback too.

*Shipped on the Server.app side.* While at least one host is configured,
Server.app starts `hivemind serve` with `--agent-port 7422`; with none it passes
nothing and drops an inherited `HIVEMIND_AGENT_PORT`, so the server runs no agent
listener. Adding the first host or removing the last one restarts a running
server once for it.

## Remote runtime

Server.app installs what the MCP needs on each host, in
`~/Library/Application Support/Hivemind/remote/<version>/` there: its own bundled
Node.js and the server package, the same files as its own `Contents`. It checks the
version at every connection and replaces it when the control Mac updates, so the
MCP on a host always matches the server. The copy goes over the master connection
(`tar` on stdin). A host needs no Node.js or Hivemind install of its own.

*Shipped* (HivemindKit's `RemoteRuntime` and `RemoteRuntimeInstaller`). The
folder holds `node` (Contents/Helpers/node), `server/` (Contents/Resources/server),
`tmux.conf` (the one the broker writes here) and `runtime.stamp`. The stamp is the
version and a digest of the copied files' names and sizes (the server package
without `node_modules`, whose `package-lock.json` is hashed instead), so a rebuild
with the same version is copied again. Each connection runs one check over the
master, which prints `uname -s` and `uname -m` and the stamp, each after a marker
so that what the host's shell startup files print does not matter: a host that is not
`Darwin arm64` gets no copy and shows why, a missing or different stamp starts the
copy. The copy extracts into a private folder next to the target, checks that its
`node --version` runs, writes the stamp last and only then moves the folder into
place, so a copy cut short never looks finished. The app-support folder and the
runtime folders are 0700. Of the other versions only the newest is kept, for
agents still running its MCP. A copy of Server.app with no bundled runtime
(`swift run`) shows that instead.

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

Shipped with the same work, independent of hosts. Today an attachment must be one
of nine types (`ALLOWED_MIMES`: PNG, JPEG, WebP, GIF, PDF, plain text, CSV, JSON,
ZIP), because files are served inline from the Human UI's origin, where an HTML or
SVG file would run its script with the Human's powers.

- **Upload.** Any type is accepted, with the current limits (512 MB per file, the
  8 GiB quota, at most 4 per message) and `attach`'s refusal of sensitive files
  (keys, `.env*`, `~/.ssh`, …).
- **Preview.** Only a safe list renders inline: raster images (not SVG), PDF and
  plain text. Everything else shows as a file with its name, size and Download.
- **Download.** A type outside the safe list is served as
  `application/octet-stream` with `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, so a
  browser or WebView saves it and never runs it. The stored type stays the
  sender's, for the agent that fetches it.
- **Agents.** `attach` and `fetch_file` take any type, with the same sensitive-file
  filter.

## Plan

1. **Agent listener.** The agent-only listener in the Node server, behind a setting.
2. **Hosts and the host connection** (*shipped*). `hosts.json`, the supervised
   master connection with the agent forward and extra forwards, host status in the
   Server.app menu, the agent listener turned on while a host exists, the remote
   runtime install and update, and the host catalog on the server.
3. **Launch on a host.** The Host field in Launch, Resume… and templates, the host
   on launch requests and the launcher channel, the remote launch steps (clone,
   shadow homes, launch file, tmux, tap), remote session listing and kill.
4. **Terminals.** In-app attach and Open in Terminal for remote sessions.
5. **Accounts on hosts.** Home setup, the same-account check, the Accounts sheet's
   per-host status, remote usage reads, and Find last conversations per host.
6. **Attachments of any type.** The upload allowlist removed, the safe preview list,
   and download headers for every other type.
