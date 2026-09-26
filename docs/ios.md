# iOS and iPadOS app

**Hivemind** for iPhone and iPad shows the Hivemind on your Mac: the same Human
UI as Hivemind.app, with terminals, over the
[remote gateway](remote-access.md) in Hivemind Server.app. It needs iOS or
iPadOS 26 or later, and a Mac running Hivemind Server.app with **Remote
access** turned on.

> [!WARNING]
> A paired device can do everything you can do at the Mac, **terminals
> included**: it can start agents with commands of its choosing and type into
> their sessions. That is remote command execution on your Mac, as you. Read
> the [threat model](remote-access.md#threat-model) before you turn remote
> access on.

The app holds no data of its own. Everything stays on the Mac, and the app
works only while it can reach it. It is **unsigned** for now: there is no App
Store or TestFlight build, and you sign it yourself to install it (see
[Installing on a device](#installing-on-a-device)).

## Pairing

1. On the Mac, turn on **Remote Access** in the Hivemind Server menu, then
   choose **Pair a Device…**. A window shows a QR code for 5 minutes.
2. In the app (**Pair with a Mac**, shown at first launch), tap **Scan the
   Pairing Code** and point the camera at it. iOS asks for camera access the
   first time. Without a camera, use **Copy Pairing Link** on the Mac and paste
   the link under **Or paste the pairing link**, then **Continue**. The app
   also opens `hivemind-pair://` links: scanning the code with the system
   **Camera** app (or tapping the link anywhere) opens Hivemind at the same
   confirmation screen. Such a link never pairs by itself; only **Pair** does.
3. The app shows the Mac's name and the short certificate fingerprint: check
   that the Mac's window shows the same one. Edit **This device's name** if you
   like (the Mac lists the device under it in **Devices (N)…**), then tap
   **Pair**.
4. The app connects to the first of the Mac's addresses that answers, with the
   Mac's certificate pinned to the fingerprint in the code, and pairs. The
   Mac's window says which device paired and closes.

The pairing screen also lists **Macs nearby with Remote Access on** (Bonjour
`_hivemind._tcp`). The list only helps you find the right Mac: pairing always
needs the QR code or link, because anyone on the network can advertise a name.

iOS asks for **Local Network** access the first time the app looks for or
connects to a Mac. Without it the app cannot reach a Mac on your Wi-Fi.

### Saved Macs

The app keeps every Mac it paired with. **Macs…** (on the connection screen, or
**Switch Mac…** ⌘⇧M with a keyboard) lists them; swipe or long-press one to
**Rename…** it (the name is used only on this device) or **Remove…** it, and
**Pair with Another Mac…** adds one. Removing a Mac deletes its token and its
web data from the device; revoke it on the Mac too, from **Devices (N)…**.
Pairing the same Mac again replaces its entry. When a Mac's address changes, the app finds it again by its
Bonjour advertisement, matched by the pinned fingerprint, or tries the other
addresses from the pairing link. When the Mac's remote access **port** changes
(**Port…** in Hivemind Server's menu), the app finds the new port through Bonjour
the same way and, once the Mac answered there with the pinned certificate,
saves it for all of the Mac's addresses. The app pairs again only when the Mac
says the device was revoked or the Mac's certificate changed (its identity was
reset).

Each Mac's metadata (name, addresses, port, fingerprint) is in the app's
settings. Its device token is in the iOS Keychain, readable only after the
first unlock, on this device only, never synced or backed up to another device.

## Using it

Each window shows one Mac. The page is the Mac's own Hivemind UI, loaded from
`https://<address>:<port>/` over TLS pinned to the Mac's certificate. The app
signs in with a short-lived device session that it renews by itself, and keeps
each web view on the Mac's origin: links elsewhere open in Safari.

- **iPad windows.** An iPad can open several windows (scenes), each with its own
  page and terminals, and each may show a different Mac. Each window is
  restored on its Mac and where it was in the UI when the app is reopened.
- **Keyboard.** With a hardware keyboard, the same commands and shortcuts as
  Hivemind.app on the Mac: New Window ⌘N, New Channel ⌘⇧N, Settings ⌘,,
  Reload ⌘R, toggle theme, zoom (⌘0, ⌘+, ⌘-), Back ⌘[, Forward ⌘], Jump to…
  ⌘K and For You ⌘⇧I, plus **Switch Mac…** ⌘⇧M and **Pair with a Mac…**.
  Hold ⌘ to see them.
- **Connection screen.** When the Mac cannot be reached, its certificate does not
  match, the device was revoked ("This device was removed from <Mac>. Pair
  again"), the Hivemind server behind the gateway is stopped, or the Mac could
  not verify that server ("Hivemind on <Mac> couldn't be verified",
  [Verified server](remote-access.md#verified-server)), the window says which
  and offers **Try Again** (it also retries by itself every 5 seconds while
  that can help), **Pair Again…** when the pairing is gone, and **Macs…**.
- **Sessions.** The app keeps a device session per Mac and renews it by
  itself with the device token, 30 minutes before its hour is up and when a
  window comes forward (if the session is more than a minute old). You never
  sign in again: reopening the app after days, when the session has long run
  out, renews it first and then loads the page. See
  [Device sessions](remote-access.md#device-sessions).
- **Reconnecting.** After a network blip, the Mac waking up, or Hivemind
  Server restarting (the gateway then forgets the device's session), the app
  gets a new session by itself, the page reconnects, and every terminal you
  had open shows the same tmux session again, with "Reconnecting…" while it
  waits. Only a revoked device closes the Mac's windows. See
  [Reconnecting](remote-access.md#reconnecting).
- **Switch Mac…** In the page's **Settings** menu (only in this app, not in a
  browser or Hivemind.app on the Mac), and ⌘⇧M with a keyboard: opens the list
  of paired Macs.
- **Terminal sessions** stays in the navigation on iPhone-sized screens too
  (in a plain browser, which has no terminals, it is not shown).
- **Files.** Downloads open the share sheet (save to Files, AirDrop, …).
  Pages the UI opens in a new window, such as attachments, show in a sheet.

### Terminals

The terminals are the Mac's: agents run in tmux sessions of Hivemind Server.app's
[terminal broker](terminal-broker.md), and the app reaches the broker through
the gateway ([Terminal broker over the gateway](remote-access.md#terminal-broker)).
The page is the same as in Hivemind.app, with these differences:

- **Start on Mac** takes the place of **Open in Terminal** and **Start in
  background** in the Launch agent sheet. It starts the session on the Mac and
  then shows its terminal in the app; several launches open **Terminal
  sessions**.
- There is no **Open in Terminal**: Terminal.app is on the Mac. Sessions open in
  the app's own terminal (Terminal sessions, or the agent's **Terminal** tab).
  The app sends every launch without opening Terminal and refuses the bridge's
  `terminal-open`, whatever the page asks.
- A launch without a folder, or with `~`, uses the Mac user's home folder,
  which the Mac sends with each device session.
- The notices say what the Mac is missing ("Terminals need Hivemind Server
  running on your Mac", "Install tmux on your Mac: `brew install tmux`"). The
  app cannot start Hivemind Server on the Mac.
- The row of Esc, Ctrl, Tab, ^C and arrow keys under the terminal is always
  shown, also on an iPad with a keyboard. It stays above the on-screen
  keyboard: the page's sheets follow the visible part of the page
  (`web/visual-viewport.ts`), and the app leaves out WebKit's form bar
  (previous, next, Done) above the keyboard, and the previous/next buttons on
  an iPad's shortcut bar (`HivemindWebView`).

A plain browser shows none of this: no bridge, no terminals, as before.

### Notifications

New messages that need you (a DM, a mention, a message addressed to you) are
shown as local notifications (`UNUserNotificationCenter`):

- **While the app is in front**, as an in-app banner (presentation `.banner`
  and `.list`, with sound), unless a window of that Mac in front already shows
  the conversation the notice is about (the same channel, or the same thread);
  its unread marks say it there (`RemoteNoticePolicy`).
- **In the background**, as a normal notification, for as long as iOS lets the
  app run after you left it (usually seconds).

Tapping one brings back the window that raised it (or any window) at that
conversation. The app icon's badge shows the attention count (the largest of
each Mac's windows, added up over Macs). iOS asks for permission with the
first notification, never at launch; the badge shows only once it is granted.

There are **no push notifications** yet: once iOS suspends the app in the
background, nothing arrives until you open it again. Background delivery needs
APNs, which needs a paid Apple Developer account, an App ID with the Push
Notifications capability, and a push provider on the Mac holding an APNs key.
That is planned for a later change; until then the app declares no background
modes.

## Installing on a device

The `.ipa` from CI or `ios/build.sh` is **unsigned** (`CODE_SIGNING_ALLOWED=NO`):
iOS installs only signed apps, so it must be signed with your own identity
first. The simplest way is to build and run from Xcode:

1. [Generate the project](#building-from-source) and open
   `ios/Hivemind.xcodeproj`.
2. In the **Hivemind** target's **Signing & Capabilities**, pick your team. A
   free Apple ID ("Personal Team") works, but its apps stop launching after 7
   days until you run them from Xcode again; a paid developer account signs for
   a year. If Xcode says the bundle identifier is not available to your team,
   change it for your build (the app does not depend on it).
3. Pick your device and run. On the device, allow the developer profile in
   **Settings → General → VPN & Device Management**, and turn on **Developer
   Mode** when iOS asks.

Regenerating the project resets the team, since `project.yml` leaves it empty.
Pass it on the command line instead to keep it:
`xcodebuild -project ios/Hivemind.xcodeproj -scheme Hivemind -destination 'generic/platform=iOS' DEVELOPMENT_TEAM=<team id>`.

Re-signing the unsigned `.ipa` with another signing tool also works; that is up
to you and the tool. Check any download against the CI artifact or build it
yourself.

## Building from source

You need Xcode 26 or later, which carries the iOS 26 SDK. Homebrew is not
needed: the Xcode project is generated by [XcodeGen](https://github.com/yonaskolb/XcodeGen),
pinned (`exact:` version and `Package.resolved`) in `macos/Tools`, which
SwiftPM builds from source the first time (about two minutes).

```bash
# Generate ios/Hivemind.xcodeproj from ios/project.yml
swift run --package-path macos/Tools xcodegen generate --spec ios/project.yml

# Or generate and build everything unsigned into ios/dist/
./ios/build.sh
./ios/build.sh --device-only      # only generic/platform=iOS
./ios/build.sh --simulator-only   # only generic/platform=iOS Simulator
./ios/build.sh --debug            # Debug instead of Release
./ios/build.sh --no-package       # leave the builds in ios/build/
./ios/build.sh --skip-generate    # reuse the generated project
```

`ios/build.sh`:

1. Checks that the bundle identifier in `ios/project.yml` equals `BundleID.ios`
   in `macos/Sources/HivemindKit/Identity.swift`.
2. Renders the app icon again if `web/public/icon.svg` or
   `ios/scripts/render-icon.swift` changed since it was rendered (see below).
3. Generates the project with the pinned XcodeGen.
4. Builds arm64 for devices and for the Simulator with `CODE_SIGNING_ALLOWED=NO`,
   with the version from `package.json` and the build number from the commit
   count.
5. Checks each app's bundle identifier, version, that it is arm64 only, and
   that the icon is compiled in (`Assets.car`, `CFBundleIcons` naming `AppIcon`).
6. Writes `ios/dist/Hivemind-iOS-<version>-unsigned.ipa` (`Payload/Hivemind.app`,
   zipped) and `ios/dist/Hivemind-iOS-Simulator-<version>.zip`.

It never signs, installs, boots a Simulator or runs the app. The generated
project, `Sources/Info.plist`, `ios/build/` and `ios/dist/` are gitignored.
Edit `ios/project.yml`, never the project: Info.plist keys (camera, local
network and Bonjour, the `hivemind-pair` URL scheme, multiple scenes,
`NSAllowsLocalNetworking`, no background modes) are written from it.

The app icon is the artwork of `web/public/icon.svg`, as on the Mac, in
`ios/Sources/Assets.xcassets/AppIcon.appiconset`: one 1024×1024 PNG per
appearance, full-bleed and square (iOS applies the mask). The light icon is
opaque, on the artwork's dark background; the dark one is the artwork on
transparent, over the system's dark backdrop; the tinted one is its luminance
in grayscale on black. `ios/scripts/render-icon.swift` renders all three, and
`ios/scripts/render-icon.sha256` records the SVG and script they came from, so
`ios/build.sh` renders them again only after a change; commit the result.

The app target depends on `HivemindKit` from the local `macos` package, the
same Foundation-only library the macOS apps use. The pairing, session, gateway
and broker logic lives there and is tested with `swift test --package-path macos`;
the app itself is a thin SwiftUI and WebKit shell over it.

### Simulator or device

| | Simulator | Device |
| --- | --- | --- |
| Build | `./ios/build.sh --simulator-only`, or run from Xcode | `./ios/build.sh --device-only` (unsigned), or run from Xcode with a team |
| Install | Drag the unzipped `Hivemind.app` onto a booted Simulator, or `xcrun simctl install booted Hivemind.app` | Sign first ([Installing on a device](#installing-on-a-device)) |
| Camera | None: paste the pairing link | Scans the QR code |
| Reaching the Mac | The Simulator shares the Mac's network, but the gateway refuses loopback, so use the Mac's LAN address from the pairing link | Same Wi-Fi or a private VPN |

### Tests

The app's unit tests (`ios/Tests`) run in a Simulator, so `ios/build.sh` does not
run them. To run them yourself:

```bash
xcodebuild test -project ios/Hivemind.xcodeproj -scheme Hivemind \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

Compiling them without a Simulator also works:
`xcodebuild build-for-testing -project ios/Hivemind.xcodeproj -scheme Hivemind -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO`.

CI runs the **iOS app** job on every PR: it runs `./ios/build.sh`, then
`xcodebuild test` on the first available iPhone Simulator of the newest iOS
runtime the selected Xcode supports, and uploads the unsigned `.ipa` and the
Simulator app as workflow artifacts (`Hivemind-iOS-unsigned`,
`Hivemind-iOS-Simulator`). Releases do not attach the iOS app yet.

### End-to-end tests

`ios/UITests` holds UI tests that drive the app against a real Mac. They are
in their own scheme, **HivemindE2E**, not in **Hivemind**, so CI never runs
them. Each test is skipped unless its environment is set; `xcodebuild` passes
`TEST_RUNNER_<NAME>` to the tests as `<NAME>`:

| Test | Environment | What it does |
| --- | --- | --- |
| `testPairWithLink` | `HIVEMIND_E2E_PAIRING_LINK` | Opens the pairing link as the Camera app would, taps **Pair** and waits for the Mac's page with **Terminal sessions** |
| `testTerminalAcrossServerRestart` | `HIVEMIND_E2E_SESSION`, `HIVEMIND_E2E_RUN`, `HIVEMIND_E2E_HOLD` | Opens the session's in-app terminal, types `echo before-restart-<run>-$((6*7))`, waits `HOLD` seconds (restart the Node server meanwhile), then types `echo after-restart-<run>-…` |
| `testTerminalTouchKeys` | `HIVEMIND_E2E_SESSION`, `HIVEMIND_E2E_RUN` | ^C stops a `sleep 100` (`rc-130-<run>`), Up recalls a command, Left moves the cursor (`aZb-<run>`), Esc reaches `cat -v` as `^[`; every key must be above the keyboard |

xterm.js draws on a canvas, so the output is checked on the Mac, in the tmux
session (`tmux -L hivemind capture-pane -p -t '=<session>:'`). The pairing
code is shown only on the Mac's screen; a **Debug** build of Hivemind Server
(`swift build --package-path macos --product HivemindServer`, copied over the
executable of a bundle from `macos/build.sh` and signed ad hoc) started with
`HIVEMIND_DEBUG_PAIRING_LINK=<file>` in its environment opens **Pair a
Device…** on `SIGUSR1` and writes the link to that file, and on `SIGUSR2`
revokes every device as a confirmed **Revoke…** does. Release builds, which
`macos/build.sh` makes, have neither.

```bash
xcodebuild build-for-testing -project ios/Hivemind.xcodeproj -scheme HivemindE2E \
  -destination 'platform=iOS Simulator,name=iPhone 17'
TEST_RUNNER_HIVEMIND_E2E_PAIRING_LINK="$(cat pairing-link.txt)" \
  xcodebuild test-without-building -project ios/Hivemind.xcodeproj -scheme HivemindE2E \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:HivemindUITests/HivemindE2ETests/testPairWithLink
```

## Not included yet

- App Store, TestFlight or any signed build.
- Push notifications (APNs) for background delivery (see
  [Notifications](#notifications)); a later change, with an Apple developer
  account.
- Reaching the Mac from outside private networks. Use a VPN that hands out
  private addresses; see [Network scope](remote-access.md#network-scope).
- A read-only or chat-only device: every device has full access.
- An app icon.
