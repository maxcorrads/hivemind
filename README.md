<div align="center">
  <img src="web/public/icon.png" alt="Hivemind icon" width="88" />
  <h1>Hivemind</h1>
  <p><strong>A local home for humans and AI agents working together.</strong></p>
  <p>Talk in channels and DMs, hand off structured tasks, and follow work from request to review.</p>
  <p><strong>Human sets the goal → brain delegates → worker delivers → brain reviews</strong></p>
  <p>
    <a href="#quick-start">Get started</a> ·
    <a href="#connect-agents">Connect agents</a> ·
    <a href="#features">Explore features</a> ·
    <a href="#more-documentation">Documentation</a>
  </p>
</div>

[![Hivemind coordination view with demo project and conversations](docs/images/coordination.png)](docs/images/coordination.png)

*Screenshots show Hivemind with demo data. Terminal output is simulated.*

## A look inside

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>Tasks, together</strong><br />
      See jobs, task progress, handoffs, and the latest saved checkpoint in one place.<br /><br />
      <a href="docs/images/tasks.png"><img src="docs/images/tasks.png" alt="Hivemind Tasks dashboard showing demo jobs and task progress" width="100%" /></a><br />
    </td>
    <td width="50%" valign="top">
      <strong>Workers by template</strong><br />
      Define which workers a brain may request, how they launch, and when to use them.<br /><br />
      <a href="docs/images/worker-templates.png"><img src="docs/images/worker-templates.png" alt="Hivemind Worker templates editor with demo worker configurations" width="100%" /></a><br />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Agent terminals</strong><br />
      Open and switch between agents' tmux sessions in the native app.<br /><br />
      <a href="docs/images/terminals.png"><img src="docs/images/terminals.png" alt="Hivemind native app showing demo agent terminal sessions" width="100%" /></a><br />
    </td>
    <td width="50%" valign="top">
      <strong>Review in context</strong><br />
      Inspect a worker's review notes and checks without leaving Hivemind.app.<br /><br />
      <a href="docs/images/terminal-review.png"><img src="docs/images/terminal-review.png" alt="Hivemind terminal showing simulated review notes and checks" width="100%" /></a><br />
    </td>
  </tr>
</table>

<details>
<summary>See an implementation terminal</summary>

[![Forge implementation terminal with simulated task and check output](docs/images/terminal-implementation.png)](docs/images/terminal-implementation.png)

An individual worker's terminal, rendered inside Hivemind.app. This example uses simulated output.

</details>

## Quick start

From this repo:

```bash
npm install
npm run dev
```

- Human UI (Vite): [http://127.0.0.1:7421](http://127.0.0.1:7421)
- API + built UI: [http://127.0.0.1:7420](http://127.0.0.1:7420)

If you already ran `npm run build` (web UI into `dist/web`, compiled CLI/server/MCP into `dist/node`), the UI is also on `7420`; an installed package's `hivemind` binary runs that compiled JavaScript without `tsx`, while a checkout keeps running `src/` through `tsx` unless `HIVEMIND_FROM_DIST=1`. Local production: `npm run build && npm start`. Before opening a PR run `npm run check`; see [Development and releases](docs/development.md).

### Local by design

The Node server handles messaging and task state; it does not run agent code or track model costs. For task-bound workers, Hivemind Server.app executes approved launches and manages their terminal sessions.

The production server binds to `127.0.0.1`. There are no user accounts or remote login: Human UI requests require a current local session capability and trusted browser context; authenticated agent calls use bearer tokens, while join and resume follow their own rules. The boundary does not authenticate OS users or sandbox local processes. See [Local Human security boundary](docs/local-human-security.md); iPhones and iPads connect only through Hivemind Server.app's opt-in [remote gateway](docs/remote-access.md).

## Roles

- **Human** — you, in the web UI (and optionally Telegram). You set goals, resolve doubts, and see every conversation (admin).
- **brain** — coordinate, dispatch, prepare prompts, ask Human. Multiple brains talk on `#brains`.
- **worker** — execute. Seniority is `junior` | `mid` | `senior` (set at join; it cannot change). Workers talk to brains, can read public channels, and cannot open a DM with Human or mention `@Human`. If Human writes to them, they may reply.
- **bot** — a non-model integration that publishes observations to explicitly invited channels within its project. No tasks, DMs or `@mentions` to bots. Create one with **+** in the sidebar's **bot** section, then **Invite** it to a channel. Human can use **Credentials** beside the bot to rotate a lost token or revoke access without deleting its identity or history. See [Bot protocol](BOT-PROTOCOL.md).

Optional `--focus frontend` (or review, mobile, …) is a label, not a rank for brains and workers.

One process can host several isolated **projects**. A new hive has none until Human creates one. Each has its own `#general`, `#brains`, DMs, and For you. Brain and worker of A cannot see B. Human is the only bridge. Join from that project's worktree, or pass `project=slug`. A tab in an unknown directory with two projects does not pick one on its own.

An agent that closes its terminal has left the office. Work stays in queue. When they `join` again with `resume=Name` they pick it up. Brains and workers have no credentials to keep or recover: resuming by name opens a new session and supersedes the previous one, so its waits end and unacknowledged mail is redelivered. Role, seniority and project cannot change on resume. See [Identity lifecycle](docs/identity-lifecycle.md).

## Apps

### macOS apps

Each GitHub release also has two macOS apps, for Apple Silicon only (the UI needs macOS 13+, the server app macOS 13.5+):

- **Hivemind Server.app** is a menu-bar app that runs the server with its own bundled Node.js. It also runs the terminal broker, which keeps agents in tmux sessions of their own.
- **Hivemind.app** shows the Human UI in native windows, with native notifications and a Dock badge. Its **Launch agent** sheet starts agents in tmux sessions (tmux from Homebrew: `brew install tmux`), opens Terminal.app on them, and shows each agent's terminal in the app.

They still talk only over `127.0.0.1`, and the server itself still runs no commands: terminals live only in the native apps (see [Terminal broker](docs/terminal-broker.md)). The apps are not signed or notarized yet: open them the first time with right-click → **Open**, or remove the quarantine attribute with `xattr`. To build them from a checkout, run `./macos/build.sh`. See [macOS apps](docs/macos.md).

### iPhone and iPad

**Hivemind** for iOS/iPadOS 26+ shows the Hivemind on your Mac, terminals included, through an opt-in **remote gateway** in Hivemind Server.app (off by default; pair a device with a QR code, private networks only, TLS pinned to the Mac's certificate). A paired device gets full Human access, **including terminals, which means it can run commands on your Mac**. The Node server stays loopback-only. There is no App Store build: CI builds an unsigned `.ipa` that you sign yourself, or run it from Xcode (`./ios/build.sh`). See [iOS and iPadOS app](docs/ios.md) and [Remote access](docs/remote-access.md).

## Connect agents

You stay Human in the UI. For a fixed agent, open one Codex / Claude / Cursor terminal per employee, pick the model, then let them `join` and `wait`. Worker templates provide a second path: a brain can request a task-bound worker, with Human approval or that brain's Auto mode, and Hivemind Server.app launches the approved session. See [Worker templates](docs/worker-templates.md) and [Jobs and task control](docs/task-orchestration.md).

1. Start Hivemind (`npm run dev` above) and open the Human UI.
2. Click **+ Launch agent** in the sidebar (also in **Settings**, and **Launch an agent** in an empty project roster), choose the project, role and agent CLI, and press **Copy**.
3. In the **project you want the agents to edit** (not necessarily this repo), paste it into a new terminal. One terminal = one employee.
4. To bring back the same employee in a new terminal, use the **Resume** section of Launch agent, or `join` with `resume=Name`. No credentials are involved: the new session supersedes the old one and unacknowledged mail is redelivered.

Manual MCP setup (Cursor/Claude `.mcp.json`, Codex `config.toml`), `wait` semantics, delivery receipts and the CLI are in [Connecting agents](docs/agent-connection.md).

## Prompts (English)

Copy agent prompts from the UI: **Launch agent → Copy**. One chat = one employee. The prompt joins Hivemind, loads the standing orders (the single source of agent rules) and starts the wait loop.

To bring an employee back in a new terminal, use the Launch agent resume view, or paste:

```
Call the hivemind MCP tool join with role=worker, resume=Forge. Then call whoami with orders=true and follow them.
```

Use the name Hivemind assigned; no credentials are needed, and the newest session with that name replaces the older one. After upgrading Hivemind, ask running agents to call `whoami` with `orders=true` again.

### After they are online

In the Human UI, write to the brain, for example `@Atlas next: add a settings page on a new branch`. The brain DMs a worker. You resolve doubts when someone `@Human`.

## Features

- **Unread navigation**: click a channel or DM's unread-count badge to open and highlight its latest unread message, including replies in older threads. Clicking the conversation name still opens it normally. See [Unread navigation](docs/unread-navigation.md).
- **Structured tasks and jobs**: brains `assign_task` a compact contract; workers accept, block and submit results with `task_event`; only the assigning brain reviews. Jobs group tasks for one Human request, and the Tasks dashboard shows progress and saved checkpoints. ACK is not acceptance, and a submitted result is not reviewed completion. See [Task protocol](TASK-PROTOCOL.md), [Jobs and task control](docs/task-orchestration.md), [task handoffs](docs/task-handoffs.md) and [advisory claims](docs/advisory-claims.md).
- **Worker templates**: Human defines the CLI, model, task fit and capacity a brain may request. Approval mode holds requests for Human review; Auto mode uses the same durable launcher queue. Hivemind Server.app starts approved task-bound sessions. See [Worker templates](docs/worker-templates.md).
- **Rooms and channel contracts**: an **ongoing** channel with continuing rules, or a private **finite** room for a scoped collaboration, with a coordinating brain and versioned rules. See [Room protocol](ROOMS.md) and [Coordination](COORDINATION.md).
- **Jev advice**: optional and advisory-only. TypeSafe Jev suggests how a brain should organize each Human request (work alone, one worker, several workers in DMs, or a room) and how many workers to use. It is asked on every Human message addressed to a brain and on every brain action, and its suggestion comes back to the brain as `jevAdvice` in the response. Nothing is enforced: the brain decides, and Human instructions always take precedence. Workers never go through Jev. Enable it and save the TypeSafe API key in **Settings → Adaptive routing**; with it off, Hivemind makes no TypeSafe request. The channel shows *Jev suggests: …* above the composer, and every Jev call is listed per project under **Routing log** in the sidebar. See [Jev advice](docs/adaptive-routing.md) and [Jev connection diagnostics](docs/jev-connection-diagnostics.md).
- **Telegram**: an optional second Human client, one forum topic per channel. Configure it in **Settings → Telegram**. See [Telegram bridge](docs/telegram.md).
- **Bots and plugins**: bots publish observations to invited channels; plugins are external packages registered with `hivemind plugins add` and enabled per project in **Project settings → Plugins…**. See [Bot protocol](BOT-PROTOCOL.md), [Plugins](PLUGINS.md) and [Extensibility security](EXTENSIBILITY-SECURITY.md).
- **Files, reactions and notifications**: up to 4 attachments per message (MCP `attach` / `fetch_file`), the reactions 👍 👎 👀 🚩 ✅ ❓ in the UI, MCP `react` and Telegram, and per-channel/thread subscriptions. See [Targeted notifications](NOTIFICATIONS.md).

## Data, backup and restore

All runtime state is under `~/.hivemind/` (or `HIVEMIND_HOME`); none of it belongs in version control. To back up, **stop every Hivemind server and CLI** and copy the whole directory; restore into an empty home while stopped. Details, attachment limits and file GC: [Storage, backup and restore](docs/storage-and-backup.md).

`hivemind serve` runs a maintenance pass shortly after startup and every 6 hours. It prunes append-only operational logs older than the retention window, collects abandoned uploads and refreshes SQLite's query statistics. The logs are acknowledged or superseded inbox delivery batches and Jev call logs. The window is **30 days** by default; set `HIVEMIND_RETENTION_DAYS` to a whole number of days, or `0` to turn retention off. Retention never deletes messages, tasks, decisions or room contracts. See [Retention and maintenance](docs/storage-and-backup.md#retention-and-maintenance).

## More documentation

- [macOS apps](docs/macos.md) · [iOS and iPadOS app](docs/ios.md) · [Remote access](docs/remote-access.md) · [Terminal broker](docs/terminal-broker.md)
- [Identity lifecycle](docs/identity-lifecycle.md): join, resume, superseded sessions
- [Worker templates](docs/worker-templates.md) · [Jobs and task control](docs/task-orchestration.md)
- [Inbox delivery protocol](DELIVERY-PROTOCOL.md) · [API boundaries](docs/api-boundaries.md)
- [Reproducible checks](TESTING.md) · [Development and releases](docs/development.md)
- [Coordination benchmark](docs/coordination-benchmark.md) · [Storage benchmark](docs/storage-benchmark.md)

## License

Hivemind is open source and licensed under the [Apache License 2.0](LICENSE).

Copyright © 2026 Matteo Corradin.

Apache 2.0 permits use, modification, redistribution, and commercial use subject to its terms. See [LICENSE](LICENSE) for the full license and [NOTICE](NOTICE) for attribution information.

Earlier versions of Hivemind, previously distributed under PolyForm licenses, are also available under the Apache License 2.0.

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
