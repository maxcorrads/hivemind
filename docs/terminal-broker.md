# Terminal broker

Agents launched from Hivemind run in **tmux sessions**. Hivemind Server.app runs
a **terminal broker** inside its own process. The broker owns a dedicated tmux
server and the PTYs attached to it, and it serves clients over a small,
versioned JSON protocol. Hivemind.app is the first client. It relays the
broker to the page (the Launch sheet, the Sessions panel and the in-app
terminal) through the WebKit bridge. The iPhone/iPad app is the second: it
speaks the same protocol through Hivemind Server.app's
[remote gateway](remote-access.md#terminal-broker), over TLS.

The Node server has no part in this. It has no API that runs a command or
touches a terminal. It only stores the session name an agent reports on join,
as a label (`agent.terminalSession`). It does serve the page that drives the
terminals, though, so it is trusted as the UI is; see
[Security notes](#security-notes).

The contract lives in `macos/Sources/HivemindKit`:

| File | What it holds |
| --- | --- |
| `BrokerProtocol.swift` | Messages (`BrokerRequest`, `BrokerEvent` and their `…Frame`s), `BrokerLimits`, `BrokerErrorCode`, validation, and `BrokerLineReader` framing |
| `SessionName.swift` | Session naming and validation |
| `TmuxCommand.swift` | Every tmux argv, the `list-sessions` parser and the tmux config text |
| `TmuxLocator.swift` | Finding tmux |
| `BrokerPaths.swift` | The socket, token and config paths, and `BrokerToken` |
| `Bridge.swift` | The page ↔ app terminal messages (`BridgeMessage`, `BridgeTerminalEvent`) |
| `BrokerServer.swift`, `BrokerIO.swift`, `BrokerOutput.swift`, `BrokerFiles.swift`, `BrokerStatus.swift` | The broker itself (`TerminalBroker`, `BrokerConnection`) behind injectable tmux, PTY and transport seams, output batching and backpressure, its files, and the menu's status line |
| `ClientBroker.swift`, `ClientTransport.swift`, `ClientTerminalRouter.swift` | The client (`BrokerClient`), the Unix-socket transport, and the per-window relay to the page (`TerminalBridgeRouter`) |

The live pieces are in `macos/Sources/HivemindServerApp`: `BrokerSocket.swift`
(the listener), `PseudoTerminal.swift` (`forkpty`), `TmuxProcessRunner.swift`
and `TerminalBrokerService.swift`. Everything in HivemindKit is Foundation only
and tested with fakes.

The page side is in `web/native-bridge.ts` (messages and validation) and
`web/use-terminal.ts` (requests, streams and the session list), with the
session-name pattern in `src/shared/terminal-session.ts`. The broker is the authority on every limit
below. Clients check the limits first only so they can show a better message.

## tmux

Hivemind uses the user's own tmux and never bundles one. The broker looks for it
at `/opt/homebrew/bin/tmux`, then `/usr/local/bin/tmux`, then on `PATH`. It
looks again on every `hello`, so installing tmux needs no restart. Without tmux,
`welcome.tmuxPath` is `null`, and the page disables the launch buttons with
**Install tmux: brew install tmux**. There is no launch without tmux.

### A tmux server of its own

Every tmux call looks like this:

```text
tmux -u -L hivemind -f ~/Library/Application Support/Hivemind/tmux.conf <command> …
```

- `-L hivemind` gives the broker its own server socket, `hivemind`, in tmux's
  per-user socket folder. The user's default tmux server and their own sessions
  are never listed, attached or killed.
- `-f` loads Hivemind's own config instead of `~/.tmux.conf`. The broker writes
  that config (mode 0600) before its first tmux call. tmux reads it only when
  the Hivemind tmux server starts.
- `-u` makes tmux treat the client as UTF-8, so non-ASCII text is not replaced
  with `_`.

The config (`TmuxCommand.configText`):

```text
set -g default-terminal "tmux-256color"
set -as terminal-features ",xterm-256color:RGB"
set -g history-limit 50000
set -g mouse on
set -g window-size latest
set -g status off
set -g set-titles on
set -g set-titles-string "#{session_name}"
set -g allow-rename off
set -g focus-events on
set -s escape-time 10
set -g remain-on-exit off
set -g exit-empty on
```

`window-size latest` sizes each window to the client that was active most
recently. When a Terminal.app window and an in-app terminal share a session,
the one being typed in wins.

### Session names

A session name always matches `^hm-[a-z0-9][a-z0-9-]{0,78}$` (at most 82
characters):

- `hm-<project>-<agent>` for a named agent. It is always the same session, so
  relaunching the agent reuses it (for example with **Resume same employees**).
  A launch that names the agent's running session (`session`, from
  `agent.terminalSession`) reuses that one instead, whatever its name, but
  only when the broker launched that session for the same project and for no
  agent yet or for this agent: the label is whatever an agent reported on
  join, so it never makes one agent's resume report another agent's session
  as its own.
- `hm-<project>-new-<n>` for a new agent the server has not named yet. `n` is
  the lowest number free at launch. The broker runs launches one at a time,
  across all connections (`TerminalBroker.launching`), so two new agents
  launched at once from two windows never pick the same `n`.

Each part is lowercased, accents are folded, every run of other characters
becomes one `-`, and there is no `-` at either end. The project part is cut to
32 characters and the agent part to 46. An empty part becomes `project` or
`agent`. An agent whose own name would read `new-<n>` gets `a-new-<n>`, so it
cannot take a new agent's name. Two agent names that differ only in case or
punctuation ("Anne Marie" and "anne-marie") share one session. The broker picks
every name (`BrokerLaunch.sessionNames`); a client never builds one.

Names are only labels. A name reaches tmux as one argv element, and every
target is an exact `-t =<name>` (`=<name>:` for `set-option`, whose target is
a pane: tmux refuses a bare `=<name>` there), so `hm-acme` never matches
`hm-acme-atlas` by prefix.

### What tmux runs

A launch is created detached, unless a session with that name is already
running, in which case it is reused and its command is not run again:

```text
tmux … new-session -d -s <name> -n <window name> -e HIVEMIND_TMUX_SESSION=<name> \
  -- /bin/zsh -lc "cd -- '<cwd>' || exit 1
<command>

exec /bin/zsh -l" \
  ; set-option -t =<name>: @hivemind_project <project> \
  ; set-option -t =<name>: @hivemind_agent <agent>
```

- tmux runs the shell from argv directly. No shell is ever assembled from
  strings on the broker side. The folder is single-quoted inside the script,
  not passed with `-c`, because tmux expands formats (`#{…}`, and `#(…)`, which
  runs a command) in `-c`. The window name loses its `#` characters for the same
  reason.
- tmux ends a command at any argument that ends in `;`. Every free-form value
  therefore goes through `TmuxCommand.argument`, which turns a trailing `;` into
  `\;`.
- The command and then a blank line come before `exec /bin/zsh -l`. A trailing
  comment or backslash in the command cannot swallow the exec, and the session
  stays open in a login shell after the agent exits.
- `/bin/zsh -l` sources the user's `.zprofile`, so Homebrew and the rest of
  their `PATH` are there even though launchd started the app.
- `HIVEMIND_TMUX_SESSION` reaches the agent and its `hivemind mcp`. The MCP
  client checks the value against the same pattern and sends it on join. The
  server stores it and returns it as `agent.terminalSession` (see
  [The session label](#the-session-label)).
- The two user options record the project and the agent for `sessions`.

The other calls:

| Call | argv after the common prefix |
| --- | --- |
| Is it running? | `has-session -t =<name>` |
| List | `list-sessions -F '#{session_name}\|#{session_created}\|#{session_attached}\|#{pane_dead}\|#{@hivemind_project}\|#{@hivemind_agent}'` |
| Kill | `kill-session -t =<name>` |
| Attach (in a PTY, one per stream) | `attach-session -t =<name>`, with `TERM=xterm-256color` |
| Terminal.app | a self-deleting `.command` file containing `exec '<tmux>' '-u' '-L' 'hivemind' '-f' '<conf>' 'attach-session' '-t' '=<name>'` (`TmuxCommand.attachShellLine`) |

The list parser skips lines that are not Hivemind sessions. The agent field
comes last, so an agent name containing `|` still reads back whole. When the
tmux server is not running yet, `list-sessions` fails with "no server running"
(`TmuxCommand.isNoServer`), which means an empty list.

## Transports

The protocol is the same over every transport. It is a byte stream carrying
newline-delimited JSON, and nothing in HivemindKit's protocol code knows which
transport carries it.

- **Now: a local Unix socket** at `~/Library/Application Support/Hivemind/broker.sock`
  (`HivemindPaths.brokerSocket`). The broker creates the folder at mode 0700 and
  the socket at 0600, and replaces a stale socket file on start. It refuses to
  start when the path is not a socket, or when another broker still answers on
  it; such a start leaves that broker's `broker.token` and `tmux.conf` as they
  are. On Quit it removes only the socket file it created. A path longer than
  `sockaddr_un` allows (103 bytes, `BrokerPaths.fitsSocketAddress`) is reported
  as an error, never truncated. Each accepted connection must come from the
  same user (`getpeereid`); any other is closed at once.
- **Through the remote gateway** (off by default), for the iPhone/iPad app: a
  WebSocket at `wss://<gateway>/_hivemind/broker`, one frame per text
  message, with the same frames and the same `hello`. The broker still
  listens on nothing but the Unix socket: the gateway, inside Hivemind
  Server.app, is a local client of it that holds `broker.token` itself and
  puts it into the device's `hello`, so no device ever sees the token. A
  device is let in by its pairing and device session instead
  ([Remote access](remote-access.md#terminal-broker)).

## Authentication

There are two layers:

1. **Socket permissions.** Only the user can reach the socket (0600 in a 0700
   folder).
2. **A capability token** in `broker.token` (0600, `HivemindPaths.brokerToken`):
   32 random bytes as 64 lowercase hex characters (`BrokerToken`). The broker
   writes a new one each time it starts, and only once the socket is its own
   (`BrokerFiles.start`): it binds and listens first, then writes `tmux.conf`
   and the token, each to a temporary 0600 file renamed into place. A start
   that cannot listen fails before it writes either, so it never replaces the
   token of a broker that is still running. A client reads it before every
   connection and sends it in `hello`. The broker compares it in constant time
   (`BrokerToken.matches`) and never logs it.

Until a valid `hello` arrives, the broker answers every other message with
`error unauthorized` and closes the connection. It also closes a connection
that has not said `hello` within 5 s.

## Protocol

Each message is one JSON object on one line. Every message has a `type`. A
request may carry an `id` (1–64 characters, no control characters). The broker
echoes that `id` on the reply, or on the error, so the client can match them.
Pushed events have no `id`. Binary terminal data is standard base64.

The broker checks every frame completely and refuses it as a whole if anything
is wrong. Unknown keys are ignored, so a later minor addition does not break an
older peer. An unknown `type` is an error.

Version: `BrokerProtocol.version` = **1**. A client sends the highest version it
speaks. The broker answers with `min(client, broker)`, or with
`unsupported-version` below `BrokerProtocol.minimumVersion`.

### Client → broker

| type | fields | answer |
| --- | --- | --- |
| `hello` | `version` int, `token` string (≤256 B), `client` string? (≤64, a label for the log) | `welcome` |
| `sessions.list` | none | `sessions` |
| `sessions.subscribe` | none | `sessions` now, and again after each change |
| `sessions.unsubscribe` | none | none |
| `launch` | `launches`: 1–24 of `{project, agent, title, cwd, command, session?}` | `launched` |
| `attach` | `session` name, `cols` 2–1000, `rows` 1–500 | `attached`, then `output`… until `exit` |
| `input` | `stream` int ≥1, `data` base64 (1 B–64 KiB decoded) | none |
| `resize` | `stream`, `cols`, `rows` | none |
| `detach` | `stream` | `exit` |
| `kill` | `session` name | `killed` |

A launch is:

| field | rule |
| --- | --- |
| `project` | a project slug: `^[a-z0-9][a-z0-9-]{0,31}$` |
| `agent` | string or null (null for a new agent); 1–64 characters, not blank, no control characters |
| `title` | at most 200 characters, no NUL. It becomes the tmux window name (one line, no `#`, at most 60 characters). |
| `cwd` | absolute (`/…`), at most 1024 bytes, no NUL. The broker refuses a folder that is not a directory with `cwd-missing`. |
| `command` | not blank, at most 8 KiB (8192 bytes), no NUL |
| `session` | optional session name: the session this agent last reported (`agent.terminalSession`). When it is running and was launched for the same project and for no agent or this one, the launch reuses it, so an agent first launched as `hm-<project>-new-<n>` keeps that session on resume. Otherwise it is ignored: the broker never creates a session under a name the client picked. |

### Broker → client

| type | fields |
| --- | --- |
| `welcome` | `version` int, `tmuxPath` string or null |
| `sessions` | `items`: `[{name, project?, agent?, alive, attached, createdAt}]`, sorted by name. `project` and `agent` are what the launch recorded, or absent. `alive` is false when the pane is dead. `attached` counts clients (Terminal.app windows and streams). `createdAt` is Unix milliseconds. |
| `launched` | `names`: one per launch, the session name or null when that launch failed. `created`: the sessions this launch started; the others were reused. `errors`: `[{index, code, message}]`. |
| `attached` | `stream` int, `session` |
| `output` | `stream`, `data` base64 (1 B–64 KiB decoded) |
| `exit` | `stream`, `status` int or null. The stream is over: detached, the session ended, or its tmux client exited. |
| `killed` | `session` |
| `error` | `code`, `message`, `stream`? |

Error codes (`BrokerErrorCode`):

| code | meaning |
| --- | --- |
| `bad-message` | Not JSON, not an object, or a field that is missing, has the wrong type or is out of range. The message names the field, for example `launches[3].cwd: must be an absolute path`. |
| `too-large` | A line over the limit. The connection is closed. |
| `unknown-type` | An unknown `type` |
| `unsupported-version` | No common version. The connection is closed. |
| `unauthorized` | No valid `hello`. The connection is closed. |
| `tmux-missing` | tmux was not found |
| `no-such-session` | The session is not running |
| `no-such-stream` | Not a stream of this connection |
| `too-many-streams` | More than 16 streams on this connection |
| `cwd-missing` | A launch's folder is not a directory |
| `tmux-failed` | tmux ran and failed; the message has its first stderr line |
| `internal` | Anything else. A client also reads an error code it does not know as this. |

### Limits and flow control (`BrokerLimits`)

| Limit | Value |
| --- | --- |
| One client → broker line | 1 MiB. `BrokerLineReader` refuses a longer line before buffering all of it. |
| One broker → client line | 4 MiB |
| Launches per message | 24 |
| One tmux command | A launch's `new-session` arguments (with the folder, title, project and agent) may take at most 15 KiB (`TmuxCommand.maxCommandLineBytes`); tmux refuses a command over about 16 KiB. The field limits above keep every valid launch under it, and the broker still checks each one before running tmux: a longer one fails alone with `bad-message` ("too long for tmux"). |
| Streams per connection | 16 |
| Connections at once | 32 |
| `hello` deadline | 5 s |
| Session list poll | every 2 s (`tmux list-sessions`) while any connection subscribes, every 15 s otherwise (for the menu's count), and at once after a launch, kill or stream change; `sessions` is pushed only when the list changed |
| Waiting requests | `sessions.list`, `sessions.subscribe`, `sessions.unsubscribe`, `launch`, `attach` and `kill` run one at a time per connection, in order, at most 64 waiting; more get `error internal`. `launch`es also run one at a time across all connections. `input`, `resize` and `detach` never wait behind them. |
| Output batching | PTY output is gathered for about 16 ms, then sent in `output` messages of at most 64 KiB |
| Backpressure | When a connection's unsent bytes exceed 1 MiB, the broker stops reading that connection's PTYs, and resumes below 256 KiB. tmux keeps the session's scrollback meanwhile, so nothing the agent prints is lost. A client with more than about 9 MiB unsent (1 MiB plus two maximal lines) is closed. |
| Input | A PTY queues at most 1 MiB of input it has not read yet; `input` beyond that gets `error internal` with its `stream`. |

Stream ids are assigned by the broker per connection, from 1, and never reused
on that connection. `attached` always comes before the stream's first `output`,
and a stream's last output comes before its `exit`. `detach` drops the stream's
unsent output, hangs up its PTY and answers `exit` with `status: null` (and the
`detach`'s `id`, if it had one). `status` is also null when the attach process
was killed by a signal. Closing a connection detaches all its streams. The
sessions keep running.

Quitting Hivemind Server.app hangs up every PTY and closes every connection. It
never runs `kill-session`: the tmux server, its sessions and the agents in them
keep running, and the next broker finds them. The broker logs to
`~/Library/Logs/Hivemind/broker.log`, never with the token.

## Clients

`BrokerClient` (HivemindKit, `ClientBroker.swift`) is the client Hivemind.app
uses, over `UnixSocketBrokerConnector` (`ClientTransport.swift`). The iOS app
reuses it over `WebSocketBrokerConnector` (`GatewayBrokerTransport.swift`),
which sends the placeholder token the gateway replaces.

- It reads `broker.token` before every connection (refusing a symlink or a file
  over 256 bytes) and sends `hello{version: 1, token, client: "Hivemind.app"}`
  without an `id`. It gives up on a connection with no `welcome` after 5 s, and
  on a broker whose version it does not speak.
- It never gives up: it retries after 0.5 s, 1 s, 2 s, 4 s, then every 5 s,
  starting over after each `welcome`. A retry happens at once when the page
  subscribes to sessions, when the app becomes active, and when the page asks
  to start Hivemind Server. While the last `welcome` said tmux was missing,
  those also reconnect, so a newly installed tmux is found.
- `sessions.list`, `launch`, `attach` and `kill` carry ids (`c1`, `c2`, …) and
  their answers are matched by id; everything else is sent without one, and
  events without a matching id are pushes. Requests made while connecting are
  held (at most 64) and sent after `welcome`.
- It subscribes again after every reconnect. When the connection drops, every
  open stream gets `exit` with `status: null` and every unanswered request gets
  `error internal` ("Lost the connection to Hivemind Server.").
- It can stop reading the socket (`setReading(false)`) while the page is behind
  on output, and keeps that across a reconnect until told to read again; see
  [Flow control to the page](#flow-control-to-the-page). Independently, the
  socket transport stops reading while more than 1 MiB it read has not been
  handed to the main thread yet.

Hivemind.app keeps one client per primary window, started by the page's first
terminal message, and stops it when the window closes.

## The session label

The Node server knows one thing about terminals: the session name an agent
reported on join, stored as `agent.terminalSession` (migration 31,
`agents.terminal_session`). It is a label and grants nothing.

- The MCP client (`hivemind mcp`, and `hivemind join`) sends `terminalSession`
  only when `HIVEMIND_TMUX_SESSION` matches the pattern; otherwise it leaves
  the field out. The server checks the pattern again and answers 400 to
  anything else.
- Each join replaces the label, so a join or resume from outside a Hivemind
  session clears it. The latest agent to join from a session takes the label
  over from any other agent. Removing an agent clears it.
- Only the Human UI sees it (snapshot agents and `agent` events). The agents'
  own roster leaves it out.
- The label outlives the session, so the page shows a terminal only for a
  session the broker lists as alive.
- The agent CLI must pass `HIVEMIND_TMUX_SESSION` on to its MCP server. Claude
  Code passes its environment on. Codex passes only a fixed set of variables
  unless the server's config lists more: add
  `env_vars = ["HIVEMIND_TMUX_SESSION"]` to `[mcp_servers.hivemind]` (see
  [Agent connection](agent-connection.md)). Without it the agent still works,
  but the UI cannot tell which session it runs in.

## Bridge (Hivemind.app ↔ page)

Only the apps have the bridge: Hivemind.app on the Mac, and the iPhone/iPad
app with the differences listed in
[Remote access](remote-access.md#terminal-broker) (no Terminal.app, a
`platform` of `ios`). In a browser none of this exists, and the page
shows no terminal UI. The app takes these messages only from the main frame of
the pinned loopback origin (on iOS, the paired Mac's gateway origin), parses them strictly, and drops a message as a
whole if any part is wrong. Each window keeps its own broker connection, so the
page's stream ids are that connection's ids. Input, resize and detach go only to
streams this page attached, and a reload, navigation or the connect screen
detaches them and ends the page's subscription. Closing the window closes the
connection. The app keeps a map from the page's request ids to its own, and
answers with the page's `id`. The old `launch-terminal` message, which ran a
command in Terminal.app outside tmux, is gone; the app drops it like any unknown
message.

Page → app (`window.webkit.messageHandlers.hivemind.postMessage`):

| type | fields | notes |
| --- | --- | --- |
| `terminal-launch` | `id`?, `launches`: `[{project, agent, title, cwd?, command, session?}]`, `openInTerminal` boolean | `agent` is null for a new agent; `session` is the agent's `terminalSession` on resume. `cwd` may be `~` or `~/…`, or absent for home; the app expands it. With `openInTerminal`, the app then opens a Terminal.app window attached to each session the broker returned, even if the page has moved on. At most 1 per second per window. |
| `terminal-open` | `session` | Opens Terminal.app attached to a running session (the app checks with `sessions.list` first). No answer on success. At most 1 per second per window. |
| `terminal-attach` | `id`?, `session`, `cols`, `rows` | Until `terminal-attached`, the page holds the viewer's resizes (the latest size) and keys (in order, at most 64 KiB, the oldest dropped beyond), and sends them once attached; held keys are discarded if the attach fails or the viewer leaves first |
| `terminal-input` | `stream`, `data` base64 ≤64 KiB | `encodeTerminalInput` splits a paste into chunks |
| `terminal-resize` | `stream`, `cols`, `rows` | |
| `terminal-detach` | `stream` | |
| `terminal-ack` | `stream`, `bytes` int ≥1 | The page drew `bytes` (decoded) of the stream's `terminal-output`; see [Flow control to the page](#flow-control-to-the-page) |
| `terminal-kill` | `id`?, `session` | The page confirms with a modal first. At most 1 per second per window. |
| `sessions-subscribe` / `sessions-unsubscribe` | none | Subscribing also sends `terminal-status` |

App → page: `window.dispatchEvent(new CustomEvent("hivemind:terminal", {detail}))`
(`TERMINAL_EVENT`; `parseTerminalEvent` reads the detail):

| type | fields |
| --- | --- |
| `terminal-status` | `tmux`: `available` \| `missing` \| `unknown`; `broker`: `connected` \| `connecting` \| `unavailable` \| `unverified`; `platform`?: `ios` from the iPhone/iPad app, absent from Hivemind.app (read as `macos`) |
| `sessions` | `items` as the broker sends them, with `null` for a missing project or agent |
| `terminal-launched` | `id`, `names`, `created`, `errors` |
| `terminal-attached` | `id`, `stream`, `session` |
| `terminal-output` | `stream`, `data` base64 |
| `terminal-exit` | `stream`, `status` |
| `terminal-killed` | `id`, `session` |
| `terminal-error` | `id`, `code`, `message`, `stream` |

`terminal-status` is sent on every `sessions-subscribe`, and then on every
change once the page has sent any terminal message.

### Reconnecting a terminal

A stream that ends without an exit status the page did not ask for is
**lost**, not ended: the app's broker connection dropped (Hivemind Server
restarted, a network blip, on iOS the gateway going away), or the broker no
longer knows the stream (`no-such-stream`). The in-app terminal then keeps its
screen under **Reconnecting…** and, once `terminal-status` says the broker is
`connected` again and the session list shows the session alive, attaches the
same screen to the **same** tmux session again, at its current size (after
250 ms, then 1, 2 and 5 s between attempts, 5 s from then on); tmux redraws it
on attach. An attach refused while the broker settles is retried; only
`no-such-session` stops it. An exit **with** a status is real: the terminal says
**Session ended.** once the broker no longer lists the session, and
**Detached from <name>.** (with **Reconnect**) while it still runs. While a
terminal reconnects, the panel and a DM's **Terminal** tab stay; only a broker
that is `unverified`, or a session list without the session, replaces them.
This is the page's behavior in both apps (`web/use-terminal.ts`, handler
`lost`; `web/TerminalView.tsx`); `BrokerClient` reconnects the broker by itself
([Clients](#clients)).

### Flow control to the page

The page draws output more slowly than a busy agent can print it, so the app
does not hand the page everything as fast as the socket delivers it
(`TerminalBridgeRouter`, `TerminalOutputFlow`):

- **One event per stream per frame.** The app gathers a stream's output for
  about 16 ms (`TerminalBridgeRouter.outputInterval`) and sends it as one
  `terminal-output`, split at 256 KiB (decoded); a stream that gathers 256 KiB
  goes at once. Any other event first sends what was gathered, so the page
  sees events in the broker's order, and a stream's last output still comes
  before its `terminal-exit`.
- **The page acks what it drew.** When xterm has processed an output (its
  write callback), the page sends `terminal-ack{stream, bytes}` with that
  output's decoded length (`terminalDataLength`), once per output.
- **The app pauses the broker above a high-water mark.** The app counts, per
  stream, the bytes it sent or gathered and the page has not acked. When the
  window's total goes over 1 MiB (`TerminalOutputFlow.pauseAboveBytes`), the
  app stops reading its broker socket; below or at 256 KiB
  (`resumeAtBytes`) it reads again. While it does not read, the broker's own
  [backpressure](#limits-and-flow-control-brokerlimits) stops reading that
  connection's PTYs, and tmux keeps the output meanwhile. Other windows have
  connections of their own and are not held back.
- **Nothing waits for an ack that cannot come.** A stream's count is dropped
  when it exits, when the page detaches it (its output until the `exit` is then
  dropped too, and so are its acks), and on a reload, navigation or the
  connect screen. An ack for a stream that is not the page's, or for more than
  is pending, changes nothing beyond zero.

A pause holds back everything on that window's connection, not only output:
answers and session pushes wait with it. That is bounded by how fast the page
draws, and it keeps memory in the app, WebKit and the page bounded. The page ends its streams
itself when the broker leaves `connected`; the app also sends `terminal-exit`
with `status: null` for each.

Besides the broker's own errors, the page can get `terminal-error`s that the app
makes:

| code | when | message |
| --- | --- | --- |
| `internal` | a `terminal-launch`, `terminal-open` or `terminal-kill` over its throttle (with the request's `id`, if any) | "Hivemind is still handling the last request. Try again in a moment." |
| `internal` | the broker is unreachable | "Hivemind Server is not running. Start Hivemind Server to use terminals." |
| `internal` | the connection dropped before the answer | "Lost the connection to Hivemind Server." |
| `no-such-session` | `terminal-open` on a session that is not running | "<name> is not running" |
| `tmux-missing` | Terminal.app would attach, but tmux is missing | "Install tmux: brew install tmux" |
| `bad-message` | a folder too long once `~` is expanded | names the launch |
| `unauthorized` | any `terminal-launch`, `terminal-open`, `terminal-attach` or `terminal-kill` in a window opened on a server the app could not verify | "Terminals are off in this window: Hivemind couldn't verify that Hivemind Server started this server." |

With the broker `unavailable`, the page shows **Start Hivemind Server to use
terminals** with a **Start Hivemind Server** button. The button opens
`hivemind-server://start` in the page's main frame; the app cancels that
navigation, launches Hivemind Server.app (or asks the running one to start its
server, as the connect screen does) and retries the broker at once. There is no
bridge message for it. With tmux `missing`, the page shows **Install tmux: brew
install tmux**.

With the broker `unverified`, the window was opened with **Open without
terminals** on a server Hivemind.app could not verify
([Verifying the server](macos.md#verifying-the-server)). No terminal message
from that page reaches the broker: `sessions-subscribe` is answered with this
status and every request with the `unauthorized` error above. The page says
that terminals are off in this window and offers no button.

## Security notes

- **Whoever controls the page can run commands through terminals.** Hivemind.app
  accepts `terminal-*` messages from the main frame of the local origin it
  connected to, and the Node server serves that page. So a compromised Node
  server (anything that can change what it serves), or an XSS in the web UI,
  can launch sessions running commands of its choosing as you, read their
  output, type into them and kill them. This is accepted: the page is
  Hivemind's own UI and holds the Human session, so it gets the same trust as
  the UI itself, and by the user's choice a launch needs no confirmation
  ([security note](macos.md#security-note)). What bounds it:
  - **Origin pinning.** Only the main frame of the pinned loopback origin
    (`http://127.0.0.1:<port>` of the server the window connected to and
    verified; see the next note) is heard;
    another origin or an iframe is not. A browser has no bridge, so no web page
    in a browser can reach a terminal.
  - **Strict validation and limits.** Every message is parsed strictly and
    dropped whole if any part is off, with the sizes of
    [Limits](#limits-and-flow-control-brokerlimits); the broker checks
    everything again. `terminal-launch`, `terminal-open` and `terminal-kill`
    are each throttled to one per second per window. Streams belong to the
    page that attached them.
  - **The broker token and the socket's mode** keep out other local users and
    anything that cannot read the user's files; the page never sees the token.
  - **No terminal API in the Node server.** It gains nothing that runs
    commands, opens a PTY or reaches the broker, so a client that only talks
    HTTP to it (another app, a browser tab, an agent over MCP) cannot reach a
    terminal without a page loaded in Hivemind.app. The only terminal field
    the server knows is `agent.terminalSession`, a pattern-checked label.
- **Squatting the server's port.** Hivemind.app finds its server on a
  loopback port. While Hivemind is not bound there (not started yet,
  restarting, stopped), anything else can bind `127.0.0.1:7420` — another macOS
  user, or a sandboxed app that may not read your files — and answer
  `/api/health` exactly like Hivemind. Without more, the app would load its page
  and give it the whole bridge, and so terminals: commands as you. What closes
  it is the **instance challenge**: Hivemind Server.app starts every server with
  a fresh 256-bit secret, passed to node only in `HIVEMIND_INSTANCE_SECRET`
  (which the server deletes from its environment at once, so nothing it spawns
  inherits it) and written into `server.json`, `0600` in the `0700`
  app-support folder. Before a window loads a page, the app sends a fresh
  32-byte nonce to `GET /api/health/instance` and compares
  `HMAC-SHA256(secret, "hivemind-instance-v1\n" + nonce + "\n" + port)` in
  constant time. A squatter cannot read the secret, and a replayed or relayed
  answer is for another nonce or port. A server that fails, or one the
  discovery file does not name (a `hivemind serve` started by hand), is only
  ever opened on request with **Open without terminals**, and then no terminal
  message reaches the broker. The app checks again on every reload, on every
  page load it did not start itself, and whenever `server.json` changes; while
  the file is gone, a verified page's terminal messages wait. See
  [Verifying the server](macos.md#verifying-the-server).
- **Another local process running as the user** can read `broker.token` and
  use the broker. Processes of other users are refused by the socket's mode and
  by the peer check. It could already run commands as the user, so the token only
  keeps out processes that cannot read the user's files. For example, a sandboxed app can read
  neither the token nor the folder.
- **No shell built from strings.** Every tmux call is an argv array. The only
  shell text is the launch command itself, which is the agent's command by
  design, with the folder single-quoted before it. tmux format expansion and
  its `;` command separator are handled as described in
  [What tmux runs](#what-tmux-runs).
- **The user's tmux is never touched.** Everything goes to `-L hivemind` with
  Hivemind's own config, and only `hm-*` sessions are listed.
- **Bounded everything**: line sizes, launches, one tmux command, streams,
  connections, input and output chunks, and buffered output with backpressure,
  from the PTY to the page. A PTY stops being read while more than 1 MiB of its
  output waits for the main queue, and again below 256 KiB (`PTYReadGate`), on
  top of the per-connection backpressure. A misbehaving client can slow only its
  own streams.
