# macOS apps

Hivemind ships two native macOS apps next to the npm package. Both are
**Apple Silicon only** (arm64); there is no Intel build. Hivemind.app needs
macOS 13 or later; Hivemind Server.app needs macOS 13.5 or later, the floor of
its bundled Node.js 24. On an Intel Mac, use the npm package instead. They are
separate so the server can keep running with no window open, and so the UI can also reach a
server you started yourself with `hivemind serve`.

| App | What it is |
| --- | --- |
| **Hivemind Server.app** | A menu-bar app with no Dock icon. It runs and supervises `hivemind serve` with its own bundled Node.js, so nothing else needs to be installed. |
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

Each is checked with `GET /api/health` and the first that answers wins. If none
does, the window shows a connect screen. From it you can start Hivemind
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

- Page → app: `{type: "ready"}`, `{type: "badge", count}`,
  `{type: "notify", title, body, tag, target}`, where `target` is a `#/…` route,
  and `{type: "launch-terminal", launches: [{title, cwd?, command}]}` (see
  [Open in Terminal](#open-in-terminal)). Only the main frame of the local
  server's origin is heard.
- App → page: `window.dispatchEvent(new CustomEvent("hivemind:native", {detail:
  {command, hash?}}))` with `command` one of `jump`, `for-you`, `new-channel`,
  `settings`, `toggle-theme` and `navigate` (with `hash`).

### Open in Terminal

In Hivemind.app, the **Launch agent** sheet has an **Open in Terminal** button
next to **Copy command**. It opens a new Terminal.app window that runs the same
command Copy would copy, in the same workspace folder. With **Resume same
employees** on, the button reads **Open N terminals** and opens one window per
employee of the project (or of all hives) at once. Copy works as before, and a
browser shows neither button.

For each window the app writes a `.command` script (mode `0700`) into a private
folder (`0700`) under the user's temporary folder,
`$TMPDIR/Hivemind/terminal/`, and opens it with Terminal.app, as if you had
double-clicked it. The script:

1. runs in a login `zsh` (`#!/bin/zsh -l`), so your `PATH` and tools such as
   `claude` or `codex` are there as in any new Terminal window;
2. deletes itself (`rm -f -- "$0"`) and sets the window title;
3. changes to the workspace folder (`~` expanded, the path single-quoted);
4. runs the launch command;
5. then `exec`s your login shell, so the window stays open after the agent
   exits.

Opening a file with Terminal needs no Apple Events, so macOS does not ask for
Automation permission (the pasted **Copy all** script, which drives Terminal
with AppleScript, still does). If a workspace folder does not exist, the app
says so in an alert and skips that window. The page must send an absolute path
(`/…` or `~/…`); the button is disabled for any other path.

**Security note.** By the user's choice there is **no confirmation dialog**:
one click opens the terminals and runs the commands. The flip side is that any
script running in the Hivemind page could do the same. For example, an XSS in
the web UI could open Terminal windows running commands of its choosing, as
you. What limits this:

- The app accepts the message only from the main frame of the pinned loopback
  origin (`http://127.0.0.1:<port>` of the server it connected to), never from
  another origin or an iframe.
- Every message is checked strictly and dropped as a whole if any part is off:
  at most 24 launches, each command non-empty, at most 8 KB and without NUL
  bytes, a title of at most 200 characters, and an absolute folder.
- The app takes at most one such message per second per window.
- Scripts are created exclusively in a folder only you can read, and delete
  themselves when Terminal runs them; ones Terminal never ran are removed
  after a day.

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
| Discovery file | `~/Library/Application Support/Hivemind/server.json` |
| Server log | `~/Library/Logs/Hivemind/server.log`, rotated at 5 MB with 3 old files kept |
| App settings | Each app's own preferences (`com.maxcorrads.hivemind`, `com.maxcorrads.hivemind.server`) |
| Open in Terminal scripts | `$TMPDIR/Hivemind/terminal/`, each deleted when Terminal runs it |

Backup and restore of the data folder work the same as for any other server:
see [Storage, backup and restore](storage-and-backup.md). Stop the server from
the menu before copying the folder.

### Discovery file

While its server runs, Hivemind Server.app writes `server.json` (mode `0600`).
It removes the file when the server stops.

```json
{ "port": 7420, "pid": 12345, "home": "/Users/you/.hivemind", "startedAt": "2026-01-01T09:00:00Z", "version": "0.5.0" }
```

Clients treat the file as a hint. They use it only while `pid` is alive and fall
back to the configured port otherwise. The file holds no secret. The Human
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
- The health check the apps make uses a cookie-less session. It never touches
  the Human session in the windows.
- **Open in Terminal** runs commands the page sends without asking; see its
  [security note](#open-in-terminal).
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
   and `LSRequiresNativeExecution`, so macOS never offers Rosetta) and signs
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
  or a child process.
- `HivemindApp` and `HivemindServerApp` are thin app shells over it.

Its tests use fake processes and never start node or open a port:

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
