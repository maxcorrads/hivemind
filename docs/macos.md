# macOS apps

Hivemind ships two native macOS apps next to the npm package. Both are
**Apple Silicon only** (arm64); there is no Intel build. Hivemind.app needs
macOS 13 or later; Hivemind Server.app needs macOS 13.5 or later, the floor of
its bundled Node.js 24. On an Intel Mac, use the npm package instead. They are
separate so the server can keep running with no window open, and so the UI can also reach a
server you started yourself with `hivemind serve`.

| App | What it is |
| --- | --- |
| **Hivemind Server.app** | A menu-bar app with no Dock icon. It runs and supervises `hivemind serve` with its own bundled Node.js, so nothing else needs to be installed. It also runs the [terminal broker](terminal-broker.md), which keeps launched agents in tmux sessions. |
| **Hivemind.app** | The Human UI in native windows. Each window is a WebKit view of `http://127.0.0.1:<port>/`, served by the local server. |

The apps are **unsigned** for now: they carry only an ad-hoc signature (see
[Opening unsigned apps](#opening-unsigned-apps)). Developer ID signing,
notarization and connecting to a remote server come in later changes.

## Hivemind Server.app

The menu shows whether the server is running, stopped or failed, the port it
listens on, and the last error line when there is one. From the menu you can:

- **Start / Stop / Restart** the server. Stop and Quit send SIGTERM, on which
  `hivemind serve` drains its connections and releases `server.lock`; the app
  sends SIGKILL if the server has not exited after 10 s.
- **Open Hivemind** launches Hivemind.app. If it is not installed, the menu
  opens `http://127.0.0.1:<port>/` in the default browser instead.
- Set the **port** (default `7420`) and the **data folder** (default
  `~/.hivemind`, passed to the server as `HIVEMIND_HOME`). Changing either
  restarts a running server on the new setting; a server you stopped stays
  stopped.
- **Show Logs** opens the server log in Console.
- **Launch at Login** registers the app as a login item. When macOS wants you
  to approve it, the item reads "(needs approval)" and the app opens
  System Settings → General → Login Items.
- **Install command-line tool**: see [Command-line tool](#command-line-tool).

A second status line, **Terminals: …**, shows the [terminal broker](terminal-broker.md):
how many Hivemind tmux sessions run and how many are open in Hivemind.app, or
"tmux not found (brew install tmux)", or why the broker could not start. The
broker runs for the life of the app, whether or not the server does. Quitting
the app detaches every terminal open in Hivemind.app but leaves the tmux
sessions, and the agents in them, running.

The app restarts a server that crashes, waiting longer after each crash: 1 s,
doubling up to 60 s. It gives up after 8 attempts in a row, and a run that lasts
30 s resets the count. It does not retry errors that another attempt cannot
fix. The app will not start a server in these cases:

- The data folder is already owned by a live server. Its `server.lock` names a
  process that is still running.
- The port is taken.

Stop or reconfigure the other server first. The app never takes over a lock
that is still held on its own. One exception is offered, never automatic: if
Hivemind Server.app itself crashed or was force-quit, its server keeps running
and blocks the next start. When the discovery file, the lock (or port) and the
process start time all point at that old server, the menu shows **Stop Previous
Server (pid N)**; clicking it stops that process and starts a new one.

The server is the same program the npm package installs: the packed package
(`bin/`, `dist/` and the production `node_modules`) runs on the app's own Node.js
binary. The Node.js version is pinned in `macos/build.sh`.

## Hivemind.app

Hivemind.app finds the server in this order:

1. The [discovery file](#discovery-file) written by Hivemind Server.app. It is
   used only while its process is alive.
2. The port entered on the connect screen. Hivemind.app keeps it in its own
   settings, separate from the server app's port.
3. The default port `7420`.

Each is checked with `GET /api/health`. The server the discovery file names must
then also pass the [instance challenge](#verifying-the-server); only a verified
server is opened with the whole bridge. A server that answers but is not
verified (it failed the challenge, or no discovery file names it, as with a
`hivemind serve` started by hand) shows the connect screen with **This server
couldn't be verified** and an **Open without terminals** button. If nothing
answers, the window shows a connect screen too. From it you can start Hivemind
Server.app (offered when it is installed), enter another port, or retry; it
also retries by itself every 2 s. **Start Hivemind Server** launches the server
app, or, when it is already running with its server stopped or failed, asks it
to start the server. It does this by opening `hivemind-server://start` with the
server app. The server app accepts only that exact URL, and only does what its
own **Start Server** item does.

All windows share WebKit's default website data store, so they share one Human
session cookie. Links to any other host open in the default browser. The
windows only ever show pages from the local server's origin.

Native parts of the app:

- **Menus**:
  - File: New Window ⌘N, New Channel ⌘⇧N, Close ⌘W.
  - View: Reload ⌘R, zoom, and toggle theme.
  - Go: Back ⌘[, Forward ⌘], Jump to… ⌘K, For You ⌘⇧I.
  - Hivemind: About, Settings… ⌘, (opens the web UI's settings menu, or the
    port field on the connect screen).
  - Help: opens the documentation.
- **Notifications**: macOS notifications are used instead of the browser's
  Notification API, and only while the app is in the background. macOS asks for
  permission on the first one, not at launch. Clicking one focuses the window
  and opens the message it refers to. System Settings → Notifications controls
  whether they are shown; the web UI's own notification toggle is hidden in the
  app.
- **Dock badge**: shows the same attention count as the browser tab title.
- **Window state**: macOS restores open windows when the app is reopened.

The page and the app exchange a few small messages through a WebKit message
handler named `hivemind`. `web/native-bridge.ts` is active only when that
handler exists, so a normal browser behaves exactly as before. The contract is
`macos/Sources/HivemindKit/Bridge.swift`:

- Page → app: `{type: "ready"}`, `{type: "badge", count}` and
  `{type: "notify", title, body, tag, target}`, where `target` is a `#/…` route.
  Only the main frame of the local server's origin is heard.
- App → page: `window.dispatchEvent(new CustomEvent("hivemind:native", {detail:
  {command, hash?}}))` with `command` one of `jump`, `for-you`, `new-channel`,
  `settings`, `toggle-theme` and `navigate` (with `hash`).
- Terminals: the `terminal-*` and `sessions-*` messages and the
  `hivemind:terminal` event are described in
  [Terminal broker](terminal-broker.md#bridge-hivemindapp--page). See
  [Terminals](#terminals) for what they do.
- The page starts Hivemind Server (for **Start Hivemind Server** on a terminal
  notice) by opening `hivemind-server://start` in its main frame. The app
  cancels that navigation and does what the connect screen's button does; it is
  not a bridge message.

### Verifying the server

Anything can listen on `127.0.0.1:7420` while Hivemind is not bound there (not
started yet, restarting, stopped): another macOS user, or a sandboxed app that
cannot read your files. It could answer `/api/health` exactly like Hivemind, and
the page it served would get the native bridge, whose terminals run commands as
you. So Hivemind.app verifies the server before it loads the page:

1. On every start, including restarts, Hivemind Server.app makes a fresh
   256-bit random secret (`InstanceSecret`). It reaches node only in the
   environment variable `HIVEMIND_INSTANCE_SECRET`, which the server reads once
   and deletes from its environment, so plugins, agents and anything else it
   spawns never inherit it. It is also written into the
   [discovery file](#discovery-file), and never logged.
2. Hivemind.app reads `server.json` only when it is a regular file (not a
   symlink) owned by you with mode `0600`; the folder is kept at `0700`.
3. It sends a fresh 32-byte nonce to
   `GET /api/health/instance?nonce=<64 hex>`. The server answers
   `{"proof": hex(HMAC-SHA256(secret, "hivemind-instance-v1\n" + nonce + "\n" + port))}`,
   where `port` is the port the request actually arrived on, with
   `Cache-Control: no-store`. It answers 404 when it has no secret and 400 for a
   malformed nonce. The endpoint passes the same Host/Origin checks as
   `/api/health` and needs no Human session
   ([Local Human security boundary](local-human-security.md)).
4. The app compares the proof in constant time (CryptoKit). Only then does the
   page load with terminals.

A server that fails, or that only the configured or default port found (no
discovery file names it), is not trusted with terminals. The connect screen says
**This server couldn't be verified** and why, and offers **Open without
terminals**: the page then loads, notifications and the Dock badge work, but no
`terminal-*` or `sessions-*` message from that window reaches the broker. The
page gets `terminal-status` with broker `unverified` and shows that terminals
are off in this window. The window remembers the choice for that port, so a
reload does not ask again; it never grants terminals.

The app verifies again:

- on every reload (View → Reload, and when the web content process restarts);
- when the page loads a document the app did not load itself right after a
  check (the page reloading itself, back/forward): until the server is verified
  again as the same process, the page's terminal messages wait;
- whenever `server.json` changes (it looks once a second while a page shows, and
  when the app becomes active). A new process, or a new port, means a new
  document: the page is loaded again from the verified server. While the file is
  gone (the server stopped or is restarting), a verified page's terminal
  messages wait and its streams are detached, since nothing proves who answers
  on the port; the app keeps checking, and if something that cannot be verified
  answers meanwhile, the window switches to the connect screen. A window opened
  without terminals is upgraded once Hivemind Server's own server verifies.

### Terminals

Agents launched from Hivemind.app always run in **tmux sessions** that Hivemind
Server.app's [terminal broker](terminal-broker.md) owns, on a tmux server of
Hivemind's own (`tmux -L hivemind`). Your own tmux sessions are never touched.
tmux comes from Homebrew (`brew install tmux`); Hivemind never bundles it. A
browser shows none of this: it has no bridge, and the Launch sheet offers only
**Copy** there.

**Launch agent sheet.** Next to **Copy command** there are two buttons:

- **Open in Terminal** starts the agent in its own tmux session and opens a
  Terminal.app window attached to it.
- **Start in background** starts the session without a window. Open it later
  from **Terminal sessions** or the agent's **Terminal** tab.

With **Resume same employees** on, they read **Open N terminals** and **Start
N in background** and launch one session per employee of the project (or of all
hives). An employee whose session is still running keeps it, even one first
launched as a new agent: the sheet says "already running" and nothing is
started again. Both buttons are disabled with
a notice while the app connects to the broker, with **Start Hivemind Server to
use terminals** (and a button that starts it) when Hivemind Server is not
running, and with **Install tmux: `brew install tmux`** when tmux is missing.
There is no launch outside tmux. **Copy** and **Copy all** work as before: the
pasted text opens plain Terminal windows, not tmux.

Each session is named `hm-<project>-<agent>`, or `hm-<project>-new-<n>` for a
new agent whose name is not known yet. It starts in the workspace folder and
runs the same command **Copy** would copy, in a login `zsh`, then stays open in
a login shell after the agent exits. The session's shell carries
`HIVEMIND_TMUX_SESSION=<name>`, which the agent's `hivemind mcp` reports on
join; the UI maps agents to sessions by that label
([Terminal session label](agent-connection.md#terminal-session-label)).

**In the app:**

- **Terminal sessions** (above **Launch agent** in the sidebar, with the number
  running) lists every Hivemind session: the agent it maps to, running or
  exited, attached clients and start time. **Open** shows the session in an
  in-app terminal, **Open in Terminal** attaches a Terminal.app window, and
  **Terminate** ends the session and everything in it after a confirmation.
- A DM with an agent whose session is running has a **Terminal** tab with the
  same in-app terminal.
- Roster rows show a small terminal icon for an agent with a running session.

The in-app terminal is xterm.js, loaded only when a terminal is first shown. It
takes typing, paste, Ctrl+C and resizes, and keeps tmux's scrollback (50,000
lines). A Terminal.app window and any number of in-app terminals can show one
session at once; the one typed in last sets the size. On a touch screen a row of
Esc, Ctrl, Tab, ^C and arrow keys is shown. Reloading or closing the window
detaches its in-app terminals; the sessions keep running.

**Open in Terminal** writes a `.command` script (mode `0700`) into a private
folder (`0700`) under the user's temporary folder, `$TMPDIR/Hivemind/terminal/`,
and opens it with Terminal.app, as if you had double-clicked it. The script
deletes itself (`rm -f -- "$0"`), sets the window title and runs
`exec tmux -L hivemind … attach-session -t =<name>`. The app builds that line
itself; the page never supplies what the script runs. Opening a file with
Terminal needs no Apple Events, so macOS does not ask for Automation permission
(the pasted **Copy all** script, which drives Terminal with AppleScript, still
does). Closing the window detaches it; the session keeps running.

Processes in the sessions are started by Hivemind Server.app, so macOS privacy
prompts (for example for the Documents folder) name **Hivemind Server**.

#### Security note

By the user's choice there is **no confirmation dialog** for a launch: one click
starts the sessions and runs the commands. The flip side is that any script
running in the Hivemind page could do the same. The app hears terminal messages
from the page of the local server it connected to, and that server serves the
page, so an XSS in the web UI or a compromised local server could start
sessions running commands of its choosing, as you, read their output, type into
them or terminate them. This is accepted because the page is Hivemind's own UI,
trusted as the UI itself is. What limits this:

- The app accepts terminal messages only from the main frame of the pinned
  loopback origin (`http://127.0.0.1:<port>` of the server it connected to),
  never from another origin or an iframe, and only once that server has
  [proved](#verifying-the-server) it is the one Hivemind Server.app started. A
  process that took the port while Hivemind was not bound gets no terminals.
- Every message is checked strictly and dropped as a whole if any part is off:
  at most 24 launches, each with a project slug, an agent name of at most 64
  characters or none, a command that is non-empty, at most 8 KiB and without NUL
  bytes, a title of at most 200 characters and an absolute folder (`/…` or
  `~/…`). The broker checks everything again, and refuses a launch whose tmux
  command would pass 15 KiB (tmux itself stops at about 16 KiB).
- The app takes at most one `terminal-launch`, one `terminal-open` and one
  `terminal-kill` per second per window, each counted on its own, and answers a
  refused one with an error.
- Streams belong to the page that attached them: another page load in the
  window detaches them, and input goes only to a stream the page attached.
- `.command` scripts are created exclusively in a folder only you can read, and
  delete themselves when Terminal runs them; ones Terminal never ran are
  removed after a day.
- The broker's token and its `0600` socket keep out other users and apps that
  cannot read your files; the page never sees the token.
- The Node server has no terminal API at all, so a client that only talks HTTP
  to it (another app, a browser tab, an agent) cannot reach a terminal; only a
  page loaded in Hivemind.app can. See the
  [broker's security notes](terminal-broker.md#security-notes).

The page itself is the local server's own UI. The protections that keep other
code out of it, and so out of this feature, are the ones in
[Local Human security boundary](local-human-security.md).

### Debugging the page

To debug the page, run
`defaults write com.maxcorrads.hivemind webInspector -bool true` and reopen the
window: it can then be inspected from Safari's Develop menu (macOS 13.3+).

## Files and locations

| What | Where |
| --- | --- |
| Server data (messages, uploads, `server.lock`) | `~/.hivemind/`, or the data folder chosen in the menu |
| Discovery file | `~/Library/Application Support/Hivemind/server.json` (`0600`, in a `0700` folder) |
| Server log | `~/Library/Logs/Hivemind/server.log`, rotated at 5 MB with 3 old files kept |
| Terminal broker log | `~/Library/Logs/Hivemind/broker.log` |
| Terminal broker socket and token | `~/Library/Application Support/Hivemind/broker.sock` (`0600`) and `broker.token` (`0600`), new on every broker start |
| Hivemind's tmux config | `~/Library/Application Support/Hivemind/tmux.conf`, rewritten on every broker start |
| App settings | Each app's own preferences (`com.maxcorrads.hivemind`, `com.maxcorrads.hivemind.server`) |
| Open in Terminal scripts | `$TMPDIR/Hivemind/terminal/`, each deleted when Terminal runs it |

Backup and restore of the data folder work the same as for any other server:
see [Storage, backup and restore](storage-and-backup.md). Stop the server from
the menu before copying the folder.

### Discovery file

While its server runs, Hivemind Server.app writes `server.json`: a new file
created with mode `0600` and renamed into place, in the app-support folder it
keeps at `0700`. It removes the file when the server stops.

```json
{ "home": "/Users/you/.hivemind", "instanceSecret": "<64 hex characters>", "pid": 12345, "port": 7420, "startedAt": "2026-01-01T09:00:00Z", "version": "0.5.0" }
```

`instanceSecret` is the server's per-start secret for the
[instance challenge](#verifying-the-server); keep the file private. Hivemind.app
refuses a `server.json` that is a symlink, not a regular file, not yours, or not
mode `0600`. Clients use the file only while `pid` is alive and fall back to the
configured port otherwise, where a server is found but never verified. The Human
session still comes from the browser flow described in
[Local Human security boundary](local-human-security.md).

## Command-line tool

**Install command-line tool** writes a small `hivemind` shell script. It runs
the app's bundled Node.js on the bundled CLI, so `hivemind plugins …` and the
other commands work without installing Node or the npm package. There are two
destinations to choose from:

- `/usr/local/bin/hivemind`. If that folder is not writable for you, macOS asks
  for an administrator password, and only when you click the menu item.
- `~/.local/bin/hivemind`. No password is needed; the folder must be on your
  `PATH`.

The app asks before replacing a `hivemind` it did not write (for example the
npm package's link). The script points at the app's current location. If you
move or delete the app, the script says so; install it again from the menu.
While the app's server runs, the script follows its port and data folder from
the discovery file, unless `HIVEMIND_URL` or `HIVEMIND_HOME` is already set.

## Security model

The apps do not change the [Local Human security boundary](local-human-security.md):

- The server still listens on `127.0.0.1` only. There is no LAN or remote
  access and no account system.
- Hivemind.app loads the UI from `http://127.0.0.1:<port>/`, never from `file://`
  or a custom URL scheme. The Human session therefore passes the same exact
  Origin/Host checks as in a browser. The app does not add or weaken any server
  check.
- The app's App Transport Security exception allows plain http to local network
  addresses only (`NSAllowsLocalNetworking`).
- The health check and the instance challenge the apps make use a cookie-less
  session. They never touch the Human session in the windows.
- Hivemind.app gives a page its terminals only once the server has
  [proved](#verifying-the-server) it is the one Hivemind Server.app started, so
  a process that took the port while Hivemind was not bound cannot use them.
- **Terminals**: the page can start agents in tmux sessions without asking,
  and read and type into them, so whatever controls the page (an XSS, or a
  compromised local server, which serves it) can too; see the
  [security note](#security-note). The
  terminal broker listens only on a Unix socket only you can reach, and checks
  a token on every connection ([Terminal broker](terminal-broker.md#authentication)).
- `hivemind-server://start` can be opened by any app or page (a browser asks
  first). It only starts the server, as the menu's **Start Server** does.

Anything that can already talk to the local server can still do so, exactly as
before; see the threat model in the security document.

## Opening unsigned apps

The zips on the GitHub release are ad-hoc signed and not notarized, so Gatekeeper
blocks the first launch. After unzipping, move the apps to `/Applications`. Then
either:

- Control-click (or right-click) the app, choose **Open**, then **Open** again.
  On macOS 15 and later, open **System Settings → Privacy & Security** after the
  first blocked launch and click **Open Anyway**.
- Or remove the quarantine attribute that the browser set when downloading:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/Hivemind.app" "/Applications/Hivemind Server.app"
  ```

Compare the downloads with `SHA256SUMS.txt` from the same release, and with the
GitHub build provenance (`gh attestation verify <zip> --repo maxcorrads/hivemind`),
before bypassing Gatekeeper.

## Building from source

You need Xcode (Swift 6) and the repo's normal Node.js/npm setup
(`npm ci`). From the repo root:

```bash
./macos/build.sh                # both apps into macos/dist/
./macos/build.sh --ui-only      # only Hivemind.app
./macos/build.sh --server-only  # only Hivemind Server.app
./macos/build.sh --skip-node    # server app without Node.js: faster, but it cannot run a server
```

The script:

1. Builds arm64 release binaries with SwiftPM.
2. Renders the app icon from `web/public/icon.svg`.
3. Packs the server with `npm pack`. This runs the normal production build of
   `dist/web` and `dist/node`. The script then installs the production
   dependencies from `package-lock.json` without install scripts.
4. Downloads the official Node.js release for `darwin-arm64`. The tarball is
   checked against the SHA-256 pinned in the script and against the release's
   `SHASUMS256.txt` (fetched again once if a cached copy does not list it).
5. Writes `Info.plist` (bundle identifiers from `HivemindKit/Identity.swift`,
   which the apps also use to find each other; `LSArchitecturePriority` arm64
   and `LSRequiresNativeExecution`, so macOS never offers Rosetta; for the
   server app also the folder privacy strings macOS shows when an agent in one
   of its tmux sessions reaches a protected folder) and signs
   both bundles ad-hoc. It checks with `lipo -archs` that every executable is
   arm64 only.
6. Runs only `node bin/hivemind.mjs --help` from the bundle, and only on an
   Apple Silicon Mac.

Downloads are cached in `macos/.cache/` and bundles land in `macos/dist/`; both
are gitignored. Nothing in the build starts a server or opens an app.

To upgrade the bundled Node.js, change `NODE_VERSION` and `NODE_SHA256_ARM64`
in `macos/build.sh` together. Take the checksum from
`https://nodejs.org/dist/<version>/SHASUMS256.txt`.

The Swift code lives in `macos/`:

- `HivemindKit` holds all the logic that can be tested without AppKit, a network
  or a child process, the terminal broker's included. It uses Foundation only,
  so a later iOS/iPad client can reuse it.
- `HivemindApp` and `HivemindServerApp` are thin app shells over it.

Its tests use fake processes, a fake tmux and fake PTYs, and never start node or
tmux, open a PTY or a socket:

```bash
swift test --package-path macos
```

CI runs those tests and `./macos/build.sh` on every PR in the `macOS apps` job.
The job uploads both bundles as zipped workflow artifacts. Each release attaches
`Hivemind-macOS-<version>.zip` and `Hivemind-Server-macOS-<version>.zip`, lists
them in `SHA256SUMS.txt` and records build provenance for them. See
[Development and releases](development.md).

## Later

- Developer ID signing and notarization. Node.js will need the hardened runtime
  with JIT entitlements.
- Connecting Hivemind.app to a server on another machine.
