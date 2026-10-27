# Remote hosts (design)

> [!NOTE]
> Partly shipped. The [agent listener](#agent-listener) (plan step 1),
> [hosts](#hosts), the [host connection](#host-connection) and the
> [remote runtime](#remote-runtime) (step 2), the [launch](#launch) on a host
> with its session list and kill (step 3), and [accounts](#accounts), [usage](#usage)
> and [conversations](#conversations) on hosts (step 5) are in the Node server, the
> page and Hivemind Server.app; terminals on hosts (step 4) are still a design.
> The [Plan](#plan) lists the changes that build it.

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
this version's. With no host and none sent before, Server.app sends nothing. A
send that fails is retried after 2 s, doubling to a minute, while the server
stays the same; a new server ends the wait and gets the catalog at once, also
when it comes up while a send to the old one is still out.

**Requirements on the host.** macOS, SSH key login without a password
(`BatchMode=yes` must succeed), a known host key in the control Mac's
`~/.ssh/known_hosts`, and Full Disk Access for Remote Login when projects live in
a protected folder (`~/Documents`, `~/Desktop`, `~/Downloads`): processes started
by `sshd` are otherwise refused there. For launches, tmux (`brew install tmux`) and
git (for a clone) on the host; the launch steps also use the `/usr/bin/perl` that
macOS ships.

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

> [!NOTE]
> Shipped (plan step 1), and turned on by Server.app while a host exists (step 2).

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

*Shipped* (`remoteHivemindMcp` in src/shared/hosts.ts, `GET /api/ui/launch-context?project=…&host=<id>`). The
server does not know a host's home, so the MCP is `/bin/sh -c` with one line that finds the runtime of the server's own
version under `$HOME` there and runs its `node` with `server/bin/hivemind.mjs mcp` (the bundle's entry, which runs
`dist/node/cli.js`), with `HIVEMIND_HOME` set to `~/Library/Application Support/Hivemind/clients` on the host. Its
environment is `HIVEMIND_URL=http://127.0.0.1:7422` (the remote agent port) and an empty `HIVEMIND_TOKEN`; nothing in
it names a path of the control Mac. A host that is not in the catalog answers 404. As today only a Claude launch puts
the MCP on its command line; a Codex home's `[mcp_servers.hivemind]` on a host comes with [Accounts](#accounts)
(shipped: the same script, written by Server.app into the home's `config.toml`).

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

*Shipped* (steps 1–6; reading the tap back is [Usage](#usage), plan step 5), with these details:

- **Where the Host field is.** The Launch sheet (Launch agent and **Resume same employees**, one field for the
  sheet), **From a template…** (the template's host) and the template editor (`hostId`, see
  [Worker templates](worker-templates.md)). It lists **This Mac** and each host of the server's catalog
  (`GET /api/ui/hosts`, `{hosts: [{id, label, online}]}`), an offline one as "(offline)", and shows only in the apps
  and only while the catalog has a host. The sheet remembers the pick in this browser with its other settings and
  falls back to This Mac when that host is gone. A launch on an offline host is refused there and says why. The
  copied command is the host's too, for a terminal on that host. **Find last conversations** reads each online host's
  transcripts too ([Conversations](#conversations)).
- **On the wire.** A `terminal-launch` item and a broker `launch` item carry `host`, a host id; a template's launcher
  command carries it as `host` (absent with none, so a journal entry from before hosts keeps its digest). The server
  records it on the request (`launch_requests.host_id`, migration 45): the template's host when the request is made,
  the replacement template's on approval, and for a resume the host the worker last ran on. A request whose host is
  not online waits, queued (`hostWaiting` on the request), without holding up the commands behind it; a catalog put
  wakes the launcher's long poll. So does the kill of a request on a host (a stop, a cancel, a hard pause): Server.app
  cannot list an offline host, so it could not tell its session from a gone one.
- **The broker** (`BrokerRemote.swift`, `RemoteHostLaunch.swift`) runs each step as one `/bin/sh` script over the
  host's master (`HostsService` as `BrokerRemoteHosts`), built from quoted values only and read back from marker
  lines, so the host's shell startup files may print what they like. A launch takes three: a **probe** (the host's
  `$HOME`, its tmux, Homebrew's first, and its sessions), a **prepare** (the clone, then the host's facts) and a
  **start**. When a launch goes to a host, the probe of each ready host runs before the names are chosen; launches all
  on this Mac take the hosts' last lists (waiting only for a host's first), which hold each host's own launches and
  kills, so a slow host does not hold them up. A host that is offline keeps its last sessions' names taken. A launch
  that names a session running on any host reuses it where it runs.
- **Clone.** The origin goes on the prepare's stdin, not on a command line (an origin URL may hold a token), and
  `git clone` runs with `GIT_TERMINAL_PROMPT=0` into the missing folder, its parent created. A folder missing with no
  origin here fails with `cwd-missing`.
- **Facts.** The host's own `/usr/bin/perl` (part of macOS, with its `JSON::PP`) reads what the local checks read and
  nothing more: the folder; the Codex writer lock with the same `flock`s; the five keys of each Claude session record,
  its folder resolved and its process's `ps -o lstart=` while it answers signal 0; `apiKeyHelper` and the `env` names
  of the project's `.claude/settings*.json`; and for a shadow, the entries of the shadow and its shared home, their two
  `cleanupPeriodDays`, the config's credential store line and whether the shadow is logged in (never a login's
  contents). The checks then run here on those facts with the same code (`ShadowFiles`: the shadow engine runs on a
  `SnapshotShadowFiles`, whose recorded `mkdir`s and links the start applies on the host first, each refused if
  something appeared there meanwhile). An account's `~/` paths expand with the host's home.
- **Launch file.** The start's stdin, written by perl with `O_CREAT | O_EXCL | O_NOFOLLOW` at 0600 in the host's
  `launch-secrets` folder (0700, refused unless it is a real folder of the user's); leftovers older than 10 minutes go
  first, and a file whose session never started is deleted at once. The script has only its path.
- **tmux** on the host is `TmuxCommand` with the host's tmux and `~/Library/Application Support/Hivemind/remote/<version>/tmux.conf`.
- **The tap** is written by the start (0600 files through a rename, 0700 folders) under the host's
  `~/Library/Application Support/Hivemind/accounts/`; if it cannot be, its variable is left out of the launch file and
  the session starts without it, as here.

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

*Shipped:* the list and the kill (plan step 3). Each ready host is listed by the same probe, at most every 5 s
(`BrokerLimits.remoteSessionsPollInterval`, counted from its last list, failed or not) and again after a launch or a
kill there. The hosts are listed side by side, each in a task of its own, never two at once for one host: the poll
publishes this Mac's sessions with the hosts' last lists at once, and a host's list publishes when it lands, so a host
that hangs (up to the 30 s step timeout) holds up neither this Mac's list nor its launches. A client's `sessions.list`
(the launcher's among them) waits for the lists older than the interval. A host whose list fails keeps its last one,
and an offline host's sessions are not listed. Each of a host's sessions carries `host` (a host id) in `sessions`, to
the page too, which shows "on <label>" in the Terminals sheet. A `kill` (and the launcher's) goes to the host the
session is on; one no host's last list has is tried on this Mac first, and the hosts are listed only when it is not
there. The launcher takes an offline host's last sessions as still running, so its kill of one fails ("cannot reach")
instead of reporting `killed`. Attaching is step 4: until then the broker answers `attach` on a
host's session with `internal` ("runs on <label>; attach from a terminal there"), Hivemind.app opens no Terminal.app
window for one, and the sheet disables **Open** and **Terminal.app** for it.

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

*Shipped* (HivemindKit's `RemoteHostAccounts.swift` and `BrokerRemoteAccounts.swift`, the Accounts sheet), with these
details:

- **Prepare on a host.** In the apps, the Accounts sheet's **Prepare** runs on this Mac as before and, at the same time,
  on each online host of the catalog (`account.prepare` with `host`, in a task of its own: a copy of plugins can take
  minutes). Each host gets a line under the row: "<host>: Ready", what is wrong, "offline. Prepare again once it is
  online", or "not logged in. Run this in a terminal on <host>:" with the account's login command and **Copy**. The
  command is the one this Mac shows: its `~/` is the host's home there. With no host the row is as before hosts.
- **What a host gets.** Each directory of the account is created there when missing (0700), at the same path, its
  `~/` the host's home: the home, and for a Claude shadow the shadow too, whose settings, skills and plugins are its own.
  Into it goes a `tar` of this Mac's configuration, links followed: for Codex `config.toml`, `<profile>.config.toml`,
  `AGENTS.md`, `AGENTS.override.md`, `hooks.json`, `prompts`, `skills`, `rules` and `plugins`; for Claude
  `settings.json`, `CLAUDE.md`, `agents`, `commands`, `skills`, `plugins`, `hooks`, `output-styles` and
  `statusline-command.sh`. Never `auth.json`, `.credentials.json` or `.claude.json`, nor a transcript, a database or a
  cache. An entry the host already has is kept, so a host's own change survives the next Prepare (move it away there to
  get this Mac's again). A copied `plugins/*.json` that names this Mac's home names the host's. A shadow is then built
  by the same steps as here on the host's files (`ShadowHomePreparing.prepareForLogin`), its writes applied there.
- **The Codex MCP block.** A Codex home's `config.toml` on a host loses every `[mcp_servers.hivemind]` table (and its
  sub-tables) it had, this Mac's included, and gets the host's block at its end, under a marker comment: `command =
  "/bin/sh"` with the [remote runtime](#remote-runtime)'s script, `tool_timeout_sec`, `env_vars = ["HIVEMIND_TMUX_SESSION",
  "HIVEMIND_ROLE"]` and `HIVEMIND_URL = "http://127.0.0.1:7422"`. The block names the runtime's version, so each launch of
  a Codex account on a host puts this version's block back when the file differs (a failure is logged and the session
  starts with what the file has). A Codex launch without an account on a host uses the host's `~/.codex` as it is.
- **Same account check.** Prepare, and every launch of an account on a host, reads where its login lives there
  (`AccountLogin`: the shadow, else the home, else the default; for a Claude primary with neither path,
  `~/.claude.json`): the layout's login check, and for Claude the SHA-256 of `oauthAccount.accountUuid`, computed by the
  host's perl. For Codex the host runs `codex app-server` in its login shell with the account's variables, as its
  sessions would, and asks only `account/read`; its perl hashes `chatgpt:<email>` (an API key login is `api-key`) and
  prints the digest, so the email never leaves the host. This Mac's side is the same (`LocalAccountIdentity`: the
  `.claude.json`, or the usage probe's `codex app-server`). Only digests are compared, and none is logged. A Codex match
  is kept while both `auth.json` files keep their `dev:ino:size:mtime`, so a launch asks `account/read` again only after
  a new login on either side; Prepare always asks. The refusals (`launches[i].account`, `internal`), each naming the
  host, the home and the account:
  - "`~/.codex2` on Build Mac has no login of Codex work yet. Run `CODEX_HOME=~/.codex2 codex login` in a terminal on
    Build Mac, then Prepare the account in the Accounts sheet."
  - "`~/.codex2` on Build Mac is logged in to another account than Codex work on this Mac. Log in there again with
    `CODEX_HOME=~/.codex2 codex login`, then Prepare the account in the Accounts sheet."
  - "Codex work is not logged in on this Mac, so its login on Build Mac cannot be checked. Log in here first with
    `CODEX_HOME=~/.codex2 codex login`."
  - "Cannot tell which account … is logged in to: <reason>", when `codex app-server` does not answer on either side.
  Prepare answers the same: not logged in there is "not logged in" with the command, the others its error. The check
  runs after a shadow's own steps, so a shadow with no login there keeps its [own message](accounts.md#errors-and-fixes).

## Usage

- **Codex.** Unchanged: the same account reports the same windows on every host,
  and the control Mac already reads them.
- **Claude.** The tap writes on the host where the session runs. The usage probe
  reads each host's `statusline.json` and `limit-error` over the master connection
  and keeps the newest per account.

*Shipped* (`HostTaps`, `UsageProbeService`). Each round reads every ready host once, one host after another, before the
accounts: one script whose perl prints each Claude account's `statusline.json` (at most 1 MiB, base64, with its
modification time) and `limit-error` under the host's `~/Library/Application Support/Hivemind/accounts/<id>/`. The
status line used is the newest of this Mac's and the hosts', by modification time, under the [same
rules](accounts.md#usage-probe) as before; the limit error is the latest. A host that fails or is offline is skipped
for the round. With no host nothing is read.

## Conversations

**Find last conversations** scans each host's transcripts as it scans the control
Mac's (docs/terminal-broker.md#resuming-conversations), over SSH, and returns the
host with each conversation. Resuming on another host than the conversation's
needs a copy of its files first, like a copy between account homes today.

*Shipped.* In the apps the Launch sheet asks the server for this Mac's conversations and, at the same time, the broker
for each online host's (`conversations.find`, with the agents the server's scan takes: `{id, name, worktree}`). The broker
runs `hivemind conversations` there with the host's own [runtime](#remote-runtime), the agents on stdin: the server's
own `lastConversations`, on the host's home. Each answer carries its `host`; the newest conversation of an agent wins.
When an agent's conversation is on another Mac than the sheet's Host, the sheet says so ("Atlas last talked on Build
Mac: pick that Host to resume there, or copy the conversation's files first."), and a host it could not ask is named
too. Copying a conversation between hosts is not built. With no host the sheet asks the server only, as before.

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

1. **Agent listener** (*shipped*). The agent-only listener in the Node server,
   behind `hivemind serve --agent-port`. Tests: `src/server/agent-listener.test.ts`.
2. **Hosts and the host connection** (*shipped*). `hosts.json`, the supervised
   master connection with the agent forward and extra forwards, host status in the
   Server.app menu, `serve` started with `--agent-port` while a host exists, the
   remote runtime install and update, and the host catalog on the server.
3. **Launch on a host** (*shipped*). The Host field in Launch, Resume… and templates, the host
   on launch requests and the launcher channel, the remote launch steps (clone,
   shadow homes, launch file, tmux, tap), remote session listing and kill. Tests:
   `macos/Tests/HivemindKitTests/RemoteHostLaunchTests.swift` (with the fake `ssh`),
   `src/server/launcher-channel.test.ts`, `web/launch-sheet-hosts.test.tsx`.
4. **Terminals.** In-app attach and Open in Terminal for remote sessions.
5. **Accounts on hosts** (*shipped*). Home setup, the same-account check, the Accounts sheet's
   per-host status, remote usage reads, and Find last conversations per host. Tests:
   `macos/Tests/HivemindKitTests/RemoteHostAccountsTests.swift` (with the fake `ssh` and a fake `codex` on the host),
   `UsageProbeServiceTests`, `BridgeTerminalTests`, `src/server/cli-conversations.test.ts`, `web/accounts-sheet.test.tsx`,
   `web/launch-sheet-hosts.test.tsx`, `web/native-bridge.unit.test.ts`.
6. **Attachments of any type.** The upload allowlist removed, the safe preview list,
   and download headers for every other type.
