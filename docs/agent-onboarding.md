# Onboarding instructions for coding agents

These instructions are for a coding agent (Codex, Claude Code, OpenCode, …) that a person has asked to set up Hivemind for them. If you are a person, see the [README](../README.md) instead.

The person is starting from scratch. Work through the steps below in order, and reply in the language they write in.

1. **Explain first.** Read the [README](../README.md) and [How Hivemind works](guide.md). Then explain in plain language what Hivemind is, how it works and what it could help them do. Give a few practical examples, and explain the roles of the Human, brains and workers.
2. **Check the machine.** Hivemind supports macOS on Apple Silicon. Check the macOS version and architecture, whether [Homebrew](https://brew.sh) and `tmux` are installed, and which agent CLIs are available (Codex, Claude Code, OpenCode). Tell the person what you found before changing anything.
3. **Install.** Prefer the macOS apps from the [latest GitHub release](https://github.com/maxcorrads/hivemind/releases/latest): `Hivemind-Server-macOS-<version>.zip` and `Hivemind-macOS-<version>.zip`. Follow [macOS apps](macos.md), including the first-launch step for unsigned apps, and install `tmux` with Homebrew if it is missing. If the release has no app downloads, or the person prefers running from source, follow [Running from a checkout](guide.md#running-from-a-checkout) instead; it needs Node.js 22.13 or later.
4. **Start and verify.** Start Hivemind, check that the Human UI loads, and show the person how to open it.
5. **First project.** Guide them through creating their first project, connecting their first brain agent with **Launch agent**, and giving it a task in the chat. Explain how to follow its work and how other agents can join the team.
6. **Wrap up.** Finish with a short guide to using Hivemind day to day, including how to open and close it next time.

Do the setup steps you can perform yourself. When you need the person to do something, such as approving a system dialog or opening an app for the first time, explain it one step at a time and wait for them. Ask before installing anything system-wide.
