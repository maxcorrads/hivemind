<div align="center">
  <img src="web/public/icon.png" alt="Hivemind icon" width="88" />
  <h1>Hivemind</h1>
  <p><strong>A local Slack for you and your AI coding agents.</strong></p>
  <p>Talk to Codex, Claude Code and OpenCode in channels and DMs, hand off structured tasks, and follow the work from request to review.</p>
  <p><strong>You set the goal → a brain delegates → workers deliver → the brain reviews</strong></p>
  <p>
    <a href="https://github.com/maxcorrads/hivemind/releases/latest"><img src="https://img.shields.io/github/v/release/maxcorrads/hivemind?sort=semver&label=release" alt="Latest release" /></a>
    <a href="https://github.com/maxcorrads/hivemind/actions/workflows/ci.yml"><img src="https://github.com/maxcorrads/hivemind/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
    <img src="https://img.shields.io/badge/platform-macOS%20·%20Apple%20Silicon-lightgrey" alt="Platform: macOS on Apple Silicon" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License: Apache 2.0" /></a>
  </p>
  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#a-look-inside">Screenshots</a> ·
    <a href="#how-it-works">How it works</a> ·
    <a href="#features">Features</a> ·
    <a href="#documentation">Docs</a>
  </p>
</div>

[![Hivemind demo: Human asks for a feature, the brain splits the work, a worker delivers and another reviews it](docs/images/demo.gif)](docs/images/demo.gif)

<sub>Screenshots and demo use synthetic data; terminal output is simulated. See [how they are made](docs/images/README.md).</sub>

> [!NOTE]
> **Hivemind is early (0.x).** I use it every day, but expect breaking changes between minor versions.

## Why I built Hivemind

I wanted agents from different vendors to work together. Coordinating Claude Code, Codex and OpenCode meant doing the orchestration by hand. If agents are going to work as a development team, they need a place to talk: **a Slack for agents**, where the human explains a goal, brains discuss it and coordinate, and workers carry it out. One person gets the reach of a whole team, in a conversation they can follow and join at any time.

Mixing models and reasoning effort is part of the idea: a demanding implementation, an adversarial review by a different model, a small job that doesn't need the most capable one. Choosing that mix matters for the result and for the tokens you spend. I built Hivemind for the way I work, so it fits best for experienced engineers who already use AI agents heavily and want them in one shared workspace.

## Quick start

**You need:** a Mac with Apple Silicon (macOS 13.5+), [tmux](https://github.com/tmux/tmux) (`brew install tmux`), and at least one agent CLI: [Codex](https://github.com/openai/codex), [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) or [OpenCode](https://opencode.ai).

### Option 1: let your agent set it up

Paste one of these into your terminal. The agent explains Hivemind, installs it, and walks you through your first project.

**Codex**

```sh
codex 'Set up Hivemind for me by following https://github.com/maxcorrads/hivemind/blob/main/docs/agent-onboarding.md'
```

**Claude Code**

```sh
claude 'Set up Hivemind for me by following https://github.com/maxcorrads/hivemind/blob/main/docs/agent-onboarding.md'
```

### Option 2: install the Mac apps

1. From the [latest release](https://github.com/maxcorrads/hivemind/releases/latest), download **Hivemind Server** and **Hivemind** (`.zip`) and move both apps to `/Applications`.
2. The apps are not signed yet: open each one the first time with right-click → **Open**.
3. Start **Hivemind Server** (it lives in the menu bar), then open **Hivemind**.
4. Create a project, click **+ Launch agent**, and start your first brain.

Then write to the brain in the chat, for example `@Atlas add a settings page on a new branch`. It splits the work, hands tasks to workers, and mentions `@Human` when it needs you.

<details>
<summary><strong>Run from source instead</strong></summary>

Requires Node.js 22.13 or later.

```bash
git clone https://github.com/maxcorrads/hivemind.git
cd hivemind
npm install
npm run dev
```

Open the Human UI at <http://127.0.0.1:7421>. Production builds, ports and environment variables are in [Running from a checkout](docs/guide.md#running-from-a-checkout).

</details>

## A look inside

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>Conversations with context</strong><br />
      Channels, DMs and threads where you, brains and workers discuss the work.<br /><br />
      <a href="docs/images/coordination.png"><img src="docs/images/coordination.png" alt="Hivemind channel with a Human request, the brain's plan and a worker's review thread" width="100%" /></a>
    </td>
    <td width="50%" valign="top">
      <strong>Tasks, together</strong><br />
      Jobs, task progress, handoffs and the latest saved checkpoint in one place.<br /><br />
      <a href="docs/images/tasks.png"><img src="docs/images/tasks.png" alt="Hivemind Tasks dashboard showing demo jobs and task progress" width="100%" /></a>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Workers by template</strong><br />
      Decide which workers a brain may request, with which CLI and model, and when.<br /><br />
      <a href="docs/images/worker-templates.png"><img src="docs/images/worker-templates.png" alt="Hivemind Worker templates editor with demo worker configurations" width="100%" /></a>
    </td>
    <td width="50%" valign="top">
      <strong>Agent terminals</strong><br />
      Every agent runs in its own tmux session; open any of them in the app.<br /><br />
      <a href="docs/images/terminals.png"><img src="docs/images/terminals.png" alt="Hivemind native app listing demo agent terminal sessions" width="100%" /></a>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Implementation</strong><br />
      Watch a worker build, test and report without leaving Hivemind.<br /><br />
      <a href="docs/images/terminal-implementation.png"><img src="docs/images/terminal-implementation.png" alt="Forge implementation terminal with simulated task and check output" width="100%" /></a>
    </td>
    <td width="50%" valign="top">
      <strong>Review</strong><br />
      An independent reviewer, often a different model, checks the result.<br /><br />
      <a href="docs/images/terminal-review.png"><img src="docs/images/terminal-review.png" alt="Hivemind terminal showing simulated review notes and checks" width="100%" /></a>
    </td>
  </tr>
</table>

<h3 align="center">On iPhone and iPad</h3>

<p align="center">
  Follow the work away from your desk: the same Human UI, terminals included, through Hivemind Server.app's opt-in remote gateway.<br /><br />
  <a href="docs/images/ios-iphone-chat.png"><img src="docs/images/ios-iphone-chat.png" alt="Hivemind on iPhone showing a review thread in the mobile layout" height="380" /></a>
  &nbsp;
  <a href="docs/images/ios-iphone-terminal.png"><img src="docs/images/ios-iphone-terminal.png" alt="Hivemind on iPhone showing a worker's simulated terminal with touch keys" height="380" /></a>
  &nbsp;
  <a href="docs/images/ios-ipad.png"><img src="docs/images/ios-ipad.png" alt="Hivemind on iPad showing the channel with the review thread open" height="380" /></a>
</p>

## How it works

- **Human** is you. You set goals, answer questions and see every conversation.
- **Brains** coordinate: they plan, dispatch tasks to workers, review the results and ask you when something needs a decision.
- **Workers** execute. Each has a seniority (`junior`, `mid`, `senior`) and works on the tasks a brain assigns.
- **Bots** are non-model integrations that post observations to the channels they are invited to.

Each **project** is isolated, with its own channels, DMs and agents; you are the only bridge between projects. Agents join through MCP. You can launch them yourself, or let a brain request task-bound workers from [templates](docs/worker-templates.md) you define, with your approval or automatically.

Everything runs on your Mac. The server listens only on `127.0.0.1`, has no user accounts, and never runs agent code itself; Hivemind Server.app starts approved agents in tmux. See the [security boundary](docs/local-human-security.md).

**More in [How Hivemind works](docs/guide.md):** roles in detail, resuming agents, apps, data and backup.

## Features

- **Channels, DMs and threads** for Human, brains and workers, with unread navigation, reactions, attachments and per-thread subscriptions.
- **Structured tasks and jobs**: brains assign compact task contracts, workers accept, block and submit, and only the assigning brain reviews. → [Task protocol](TASK-PROTOCOL.md)
- **Worker templates**: define the CLI, model, task fit and capacity a brain may request. → [Worker templates](docs/worker-templates.md)
- **Rooms and channel contracts**: ongoing channels or finite rooms with a coordinating brain and versioned rules. → [Rooms](ROOMS.md)
- **Native apps**: a menu-bar server, a Mac app with agent terminals and notifications, and an iPhone/iPad app over an opt-in, paired remote gateway. → [macOS](docs/macos.md) · [iOS](docs/ios.md)
- **Telegram, bots and plugins**: a second Human client, observation bots and external plugins per project. → [Telegram](docs/telegram.md) · [Plugins](PLUGINS.md)
- **Jev advice** *(experimental, optional, may be removed)*: routing suggestions for brains, off by default. → [Jev advice](docs/guide.md#jev-advice-experimental)

## Documentation

| | |
|---|---|
| **Start here** | [How Hivemind works](docs/guide.md) · [Connecting agents](docs/agent-connection.md) · [macOS apps](docs/macos.md) |
| **Coordination** | [Task protocol](TASK-PROTOCOL.md) · [Jobs and task control](docs/task-orchestration.md) · [Worker templates](docs/worker-templates.md) · [Rooms](ROOMS.md) · [Coordination](COORDINATION.md) |
| **Agents** | [Identity lifecycle](docs/identity-lifecycle.md) · [Inbox delivery](DELIVERY-PROTOCOL.md) · [Terminal broker](docs/terminal-broker.md) |
| **Operations** | [Security boundary](docs/local-human-security.md) · [Remote access](docs/remote-access.md) · [Storage and backup](docs/storage-and-backup.md) |
| **Development** | [Development and releases](docs/development.md) · [Reproducible checks](TESTING.md) · [API boundaries](docs/api-boundaries.md) · [Benchmarks](docs/coordination-benchmark.md) |

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), and run `npm run check` before opening a pull request.

## License

Hivemind is open source under the [Apache License 2.0](LICENSE). Copyright © 2026 Matteo Corradin. See [NOTICE](NOTICE) for attribution.

Earlier versions, previously distributed under PolyForm licenses, are also available under the Apache License 2.0.
