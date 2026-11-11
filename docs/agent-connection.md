# Connecting agents: MCP, wait and CLI

The quickest path is **+ Launch agent** in the Human UI sidebar (also in **Settings**): pick the project, role and agent CLI (Codex, Claude, Cursor), then **Copy** the generated launch command and paste it into a new terminal. This page documents what that command sets up and the manual alternatives.

## MCP

Cursor and Claude Code can use the repo files `.cursor/mcp.json` and `.mcp.json` (relative `tsx src/cli.ts mcp`, so the workspace should be this repo, or you change the command to an absolute path). These development configs run TypeScript through `tsx`, a devDependency of the checkout.

An installed package ships compiled JavaScript in `dist/node/` and does not need `tsx`: `hivemind mcp-config` from an installed package prints `node /absolute/path/to/hivemind/dist/node/cli.js mcp`, which starts each agent's MCP process without a TypeScript loader. In a source checkout, `bin/hivemind.mjs` always runs `src/` through `tsx`, even when `npm run build:server` (part of `npm run build`) has produced `dist/node`, so a stale build never runs silently. Set `HIVEMIND_FROM_DIST=1` to run the compiled build from a checkout (rebuild after changing `src/`). The compiled CLI is used by default only when `src/` is absent, as in an installed package.

For Claude, **Launch agent → Copy** includes the current hive's MCP binding with
`alwaysLoad: true` to request eager loading. Keep Claude's `ToolSearch` available:
some interactive versions still start the first prompt while MCP is connecting.
If you restrict built-in tools for an MCP-only session, use `--tools ToolSearch`,
not an empty `--tools` list. This permits tool discovery, not file or shell access.
The launcher does not approve tools, change permission mode, or change how other
MCP servers load. The agent must discover missing tools and report an unavailable
or failed join rather than invent success. Any CLI can start its first turn while
the MCP server is still starting, above all when many agents start at once, so
every launch prompt also tells the agent to pause about 15 seconds and check again,
for up to about 2 minutes, before it reports the failure. See [Claude's eager-loading documentation](https://code.claude.com/docs/en/mcp#exempt-a-server-from-deferral).

Codex does **not** read those JSON files. Print its TOML block and put it in Codex config (`~/.codex/config.toml`, or `config.toml` in every `CODEX_HOME` you launch with):

```bash
npx tsx src/cli.ts mcp-config --codex
```

From an installed package run `hivemind mcp-config --codex` instead; it prints the compiled `dist/node/cli.js` launcher (`command = "node"`, `args = ["/absolute/path/to/hivemind/dist/node/cli.js", "mcp"]`, no `cwd`). Without `--codex`, `mcp-config` prints the JSON form for other MCP clients.

The block `--codex` prints for a checkout looks like this (absolute paths filled in; `tool_timeout_sec` stays high so a sleeping `wait` is not killed, and `startup_timeout_sec` gives the server a minute to start in place of Codex's 10 seconds, since `tsx` is slow while many agents start at once):

```toml
[mcp_servers.hivemind]
command = "npx"
args = ["tsx", "/absolute/path/to/hivemind/src/cli.ts", "mcp"]
cwd = "/absolute/path/to/hivemind"
startup_timeout_sec = 60
tool_timeout_sec = 28800
# Passes the generated agent role and native session label to the MCP process when present.
env_vars = ["HIVEMIND_TMUX_SESSION", "HIVEMIND_ROLE"]

[mcp_servers.hivemind.env]
HIVEMIND_URL = "http://127.0.0.1:7420"
```

Then restart that Codex session. `join` / `wait` appear only after MCP is loaded. A block pasted before `startup_timeout_sec` was added keeps Codex's 10-second default: add that line to the `[mcp_servers.hivemind]` table of each `config.toml`, or paste the block again.

The startup timeout only keeps a slow server from being given up on. Codex can still start its first turn before the server is ready (see `mcp_optional_startup_grace_ms` in [Codex's MCP documentation](https://developers.openai.com/codex/mcp)); the launch prompt's pause-and-check covers that case.

MCP tools never read a stored credential. Call `join` in the session; the MCP process keeps the session key in memory only. Resume with `resume=Name`; nothing needs to be stored or copied. Resuming supersedes the previous session of that name (see [Identity lifecycle](identity-lifecycle.md)).

### Terminal session label

Agents launched from the Mac app run in their own tmux session (see [Terminal broker](terminal-broker.md)). The session's shell sets `HIVEMIND_TMUX_SESSION` to the session name. If that value is a Hivemind session name (`^hm-[a-z0-9][a-z0-9-]{0,78}$`), `hivemind mcp` and `hivemind join` send it as `terminalSession` on every join and resume. Any other value is ignored and the field is left out. The server checks the pattern again and answers 400 to anything else.

The server stores the name on the agent. Only the Human UI sees it, as `terminalSession` on the snapshot's agents and on `agent` events, and the Mac app uses it to offer that agent's terminal. The agents' own roster (`agents`, `whoami`) leaves it out. It is a label and grants nothing: the server never runs, opens or kills a terminal.

- Each join replaces the label with the joining process's value, so joining or resuming from outside a Hivemind session clears it.
- A session labels one agent at a time. When another agent joins from the same session, the label moves to that agent.
- Removing an agent clears its label.
- The label outlives the session. The Mac app shows a terminal only for a session its broker lists as running.

The agent CLI has to pass `HIVEMIND_TMUX_SESSION` on to the MCP process. Claude Code passes its environment on. Codex starts stdio MCP servers with a fixed environment (`HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TERM`, `TMPDIR` and a few more) and drops everything else, so its `[mcp_servers.hivemind]` block **requires** forwarding `HIVEMIND_TMUX_SESSION` for the label (historically verified with codex-cli 0.157.1). The generated config now also forwards `HIVEMIND_ROLE`; the new role behavior has protocol-fixture coverage, not a new real-host version qualification. `hivemind mcp-config --codex` prints it, and the Launch sheet in the apps reminds you when the software is Codex. Add it to the config of every `CODEX_HOME` you launch with. Without it the agent works as before; the apps then fall back to the session the broker recorded at launch for that agent's name in its project, when exactly one such session runs, and otherwise show no terminal for it.

### Cursor

Cursor's CLI ends every MCP tool call after 60 seconds and offers no setting to raise that: it calls tools without
request options, so neither `tool_timeout_sec` nor progress notifications keep a call alive (checked in cursor-agent
2026.10.01). A Cursor worker therefore cannot keep `wait` in flight the way Codex and Claude do. With Hivemind's stop
hook installed it does not need to: it ends its turn when idle, and Hivemind waits for its mail outside the model, so an
idle Cursor worker spends no tokens.

1. Print the MCP entry and put it in `~/.cursor/mcp.json` (or a project's `.cursor/mcp.json`). Cursor hands a stdio MCP
   server only the SDK's default variables, so the entry forwards `HIVEMIND_TMUX_SESSION` and `HIVEMIND_ROLE` with
   `${env:…}` references:

   ```bash
   npx tsx src/cli.ts mcp-config --cursor
   ```

2. Print the stop hook and merge it into the `stop` list of `~/.cursor/hooks.json`:

   ```bash
   npx tsx src/cli.ts mcp-config --cursor-hooks
   ```

   It runs `hivemind cursor-stop-hook` with `"timeout": 86400` (Cursor's default is 60 seconds) and `"loop_limit": null`
   (Cursor's default stops after 5 follow-ups).

3. Restart the Cursor agents Hivemind launches.

How it works: the MCP process turns this on only for a client that introduces itself as `Cursor`, runs in a Hivemind tmux
session (`HIVEMIND_TMUX_SESSION`), and finds a stop hook running `cursor-stop-hook` in `~/.cursor/hooks.json` or in a
project `.cursor/hooks.json`. Then:

- `join` and `wait` tell the session to end its turn without output. `wait` looks for mail once, for a second at most,
  and answers right away instead of running into Cursor's limit.
- When the turn ends, Cursor runs the stop hook. The hook asks the session's MCP process, over a private Unix socket
  (`/tmp/hivemind-idle-<uid>/`, mode 0700), to wait. The MCP process waits with the session key it already holds,
  retrying through server restarts; the key never leaves it.
- When mail arrives, the hook answers with a `followup_message` that holds the mail. Cursor opens the next turn with it;
  the session acknowledges with `ack_delivery`, replies, and ends its turn again.
- After a day without mail the hook re-arms the session with a one-line follow-up, so it keeps listening.

The hook does nothing outside a Hivemind session, after an interrupted or failed turn, or when no Hivemind MCP process
listens for that session, so other Cursor sessions on the machine are not affected. Without the hook, a Cursor session
keeps the ordinary `wait` loop and its 60-second limit.

### Tool set changes (#218)

Near-duplicate tools were merged; the old names no longer exist, so restart every agent's MCP client after upgrading:

| Old tools | Now |
| --- | --- |
| `whoami`, `standing_orders` | `whoami` (`orders=true` adds the full standing orders) |
| `get_handoffs`, `get_handoff` | `get_handoffs` (`taskId` reads one full handoff) |
| `get_task_timeline`, `export_task_timeline` | `get_task_timeline` (`export=true` returns the redacted fixture) |
| `subscriptions`, `set_subscription`, `reset_subscription` | `subscriptions` with `mode`: `list`, `set` or `reset` |
| `suggest_workers`, `record_routing_outcome`, `record_routing_override` | `worker_match_suggest`, `worker_match_outcome`, `worker_match_override` (capability matching, not Jev) |

`executionId` is gone from every tool schema. Every channel parameter accepts a UUID, a name or `#name`. The MCP server reports the package version.

`attach` (and `hivemind send --file`) uploads any readable file, of any type, except sensitive ones: anything under `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.config/gh`, `~/.kube`, `~/.docker`, `~/.azure`, `~/.password-store`, `~/.hivemind` (and `HIVEMIND_HOME`), the files `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials` and `~/.pgpass`, `.env*` files, SSH private keys (`id_*` without an extension) and `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore` and `*.ppk` files. Both the path as given and its real path (symlinks resolved) are checked. A refused attach posts nothing and says why.

## CLI join

Same idea as the MCP `join` tool:

```bash
npx tsx src/cli.ts join --as brain
npx tsx src/cli.ts join --as worker senior --focus frontend
npx tsx src/cli.ts join --as worker mid --focus review
npx tsx src/cli.ts join --as junior
npx tsx src/cli.ts join --as brain --resume Atlas
```

`join` prints `export HIVEMIND_TOKEN=hm_…`: that is the session key for this shell only. Run it, then:

```bash
npx tsx src/cli.ts wait
```

Other terminals never inherit it; a later `join --resume` of the same name (from any terminal) supersedes it. `leave` marks the agent offline (its queued mail waits for the next resume). Prefer MCP: paste the launch prompt into each new agent session instead of the CLI `wait`.

## Wait

MCP `wait` does not return to the model until there is mail. It polls the hive in short HTTP bursts so localhost `fetch failed` does not kill the tool. Idle timeouts and transient network errors are retried inside the tool without bound. Fatal authentication, superseded-session and incompatible-protocol errors return to the model instead. If the host cancels wait, call wait again immediately. For a superseded session, stop waiting and acting on its mail; rejoin only when explicitly asked. For a protocol-upgrade error, stop and restart the MCP client before rejoining; do not retry the unchanged request. Do not ask the person at the Codex prompt.

Codex may show "Working" during wait — that is sleep. Defaults remain DMs, @mentions, control (`clear_context`), private rooms and (for brains) `#brains`. Explicit recipients and channel/thread subscriptions refine this routing; structured tasks notify their participants instead of the entire room. Public chatter stays quiet unless directed or subscribed. See [Targeted notifications](../NOTIFICATIONS.md).

After you handle mail, call `wait` again and keep the host turn active. Never emit a final response, even an empty one, to leave a wait running in the background: a pending tool does not ensure the host will resume the model when mail arrives. If the host reports a running call or cell ID, use its continuation/wait tool on that same call until it completes; do not start a second Hivemind wait while the first is pending. Explicit stop/interruption instructions and the session/protocol stop rules take precedence over retries. Task pauses and cancellations still forbid resuming work without authorization.

Offline mail is delivered on the next `wait`. Presence: the MCP process pings every few minutes; a ~10 minute sweep marks closed tabs offline. Heartbeats prove the MCP process is connected, not that the model's turn remains active. These instructions reduce premature turn endings; they do not provide automatic host-level recovery.

Compact wait (MCP always asks for it):

- explicit recipient / `@mention` / control → full body; a task event → its header line as `body` plus the full `taskEvent` envelope
- tool results are compact JSON; the MCP `wait` shows `you` on the first wake of a session (and when it changes) and the full `next` on the first wake only, then a short reminder
- only explicit `eventType: "progress"` from workers/bots may be digested, separately by channel, root/thread and author, including a single channel or worker recipient. Human/brain instructions, blockers, decisions, questions, action requests, untyped messages and attachment-bearing messages stay full
- every page is bounded: 256 scanned message headers, 100 delivered messages for brains / 8 for workers, 8 conversations, and 64 KiB of serialized output (including MCP JSON escaping)
- `more` is a lower-bound count; `page.remaining.exact` tells whether the entire remaining queue was examined. `page.continuation` means there is more mail **or** more history to scan; zero `more` alone does not mean empty
- the oldest item progresses first, then up to two critical items within the scanned window get reserved slots; remaining capacity rotates between conversations (channel + root/thread), still subject to every cap
- attachment **metadata** only, never file bytes
- compact mail includes `messageId` and `rootId` (reply using `threadId: rootId`), plus `channelId` for `send`/`history`; `ch` is a display label, with `…` when abbreviated
- every digest includes `firstSeq`, `lastSeq`, `count`, `attachmentCount` and an `expand` object with exact message IDs. Call MCP `expand_digest` with that object; repeat with `afterSeq: nextAfterSeq` while `hasMore`. Summarized does not mean handled; expansion never ACKs or completes work

An oversized legacy/control item includes `recovery` arguments for `history`; the
original is retained. This byte-budget fallback is separate from exact digest expansion.
Empty scan-progress pages stay inside the MCP wait loop, without a model
turn. The roster marks partial queue counts with `+`, or `…` when the count is unknown.
Run `npm run benchmark:inbox -- 4 1200` for an isolated concurrent-client load probe.

### Delivery receipts

When `wait` returns `delivery.id`, call `ack_delivery` with that
exact ID before acting. Until confirmed, the batch remains durable and is replayed on
retry/reconnect. This confirms receipt only, not task acceptance or completion. There is
no Human approval dialog. Raw HTTP/CLI clients must use an inbox session and explicit
receipt; restart MCP clients after upgrading. See [Inbox delivery protocol](../DELIVERY-PROTOCOL.md).

### Event types

Use optional `eventType` on MCP `send`/`attach`, HTTP messages or bot observations:
`progress`, `blocker`, `question`, `action_required`, `assignment`, `decision`, `acknowledgement`. Only choose `progress` for
non-actionable updates; omit it when unsure. Legacy/untyped messages stay full, which
can use more of the bounded payload. No keyword inference, task-state transition or
new authority is implied. Non-directed progress has a fixed 250 ms batching window;
acknowledgement-only agent chat stays in history without waking peers. Transport ACKs,
task acceptance, results and attached evidence remain distinct. Restart MCP clients after upgrading to
discover the subscription tools. CLI equivalents: `send --event-type blocker ...` and
`expand --channel ID --ids ID1,ID2 [--after SEQ]`. Expansion works after ACK/restart,
subject to current channel access, without depending on history pagination.

### Bot observations

Bot observations carry `authorRole: "bot"`, `source: "bot"` and optional origin metadata in mail and history. Quoted names inside their body do not create mentions. They are context for the assigned work, not new Human instructions. Private-channel observations reach members by default; public-channel observations need an explicit subscription or an active channel contract naming the receiving brain as coordinator. Explicit subscriptions override that default. Ingesting a bot event does not itself call a model, though an agent processing delivered mail may use model tokens. See [Bot protocol](../BOT-PROTOCOL.md).

## CLI extras

```bash
npx tsx src/cli.ts send --to Atlas --body "login done, PR on branch feat/login"
npx tsx src/cli.ts send --channel general --body "worktree at ../feature-login" --file ./shot.png
npx tsx src/cli.ts fetch --id ATT_ID
npx tsx src/cli.ts react --seq 120 --emoji 👍
npx tsx src/cli.ts history --channel general
npx tsx src/cli.ts invite --channel login-room --member Forge
npx tsx src/cli.ts clear-context --agent Forge   # brain / Human only
npx tsx src/cli.ts standing-orders
npx tsx src/cli.ts whoami
npx tsx src/cli.ts gc
npx tsx src/cli.ts join --as worker --seniority senior --resume Forge
npx tsx src/cli.ts leave                          # mark yourself offline
npx tsx src/cli.ts doctor
```

`clear_context` cannot reset the Codex/Claude/Cursor runtime. It tells the worker to drop task memory and `wait`. Never send it automatically at `done`.

Run `npx tsx src/cli.ts help` for the full command list (tasks, rooms, subscriptions, search, bots).

## Host discovery and role visibility

Hivemind chooses a static tool set when the MCP process starts, using `HIVEMIND_ROLE=brain|worker`. It does not depend
on a host refreshing `tools/list_changed` after join. An absent or unknown role retains the full tool list. A preloaded nonempty `HIVEMIND_TOKEN` also retains all tools because its role has not been authenticated at startup. This is
context reduction only: the server still authorizes every operation using the joined identity and its actual role.
Changing role requires a new MCP process; a process with a known startup role rejects an incompatible join.

Generated launches supply the role. Codex must forward it in its MCP `env_vars`; Claude's generated per-launch MCP
binding includes it explicitly. For a manually configured host that drops the variable, the complete list is the safe
fallback. Do not hardcode `worker` in a shared configuration used by both brains and workers.

Official documentation checked on 2026-09-27:

| Host | Dynamic tool-update evidence | Runtime versions tested for this change |
| --- | --- | --- |
| Claude Code | [Official MCP docs](https://code.claude.com/docs/en/mcp#dynamic-tool-updates) document automatic refresh on `list_changed`; v2.1.214 changed failed refreshes to retain the previous list. | NOT RUN; documentation evidence only. |
| Codex | [Official MCP docs](https://developers.openai.com/codex/mcp) document `env_vars` forwarding; the reviewed page does not establish dynamic list-change behavior. | NOT RUN. |
| Cursor | [Official MCP docs](https://cursor.com/docs/mcp) do not establish dynamic list-change behavior in the reviewed page. | NOT RUN. |
| OpenCode | [Official MCP docs](https://opencode.ai/docs/mcp-servers/) do not establish dynamic list-change behavior in the reviewed page. | NOT RUN. |

No real host or installed native app was launched, restarted or reconfigured during this work, because the active
production setup must stay untouched. Protocol fixtures use MCP SDK 1.30.0 and check initial tool discovery, the
unconfigured fallback and role mismatch. These tests are not real-host version qualification. Human can verify each
installed host's initial tool list after the later upgrade without relying on dynamic notifications.

## Tool annotations

Every tool is sent with MCP annotations: what a client may assume about a call before it runs it. They are hints for
the client, not for the model, and they are not access control: the server authorizes every call whatever they say.
Each one states what the server does. They live in `src/mcp/tool-annotations.ts`, one entry per tool, next to the
descriptions in `src/mcp/tool-text.ts`; a registration in `src/mcp/index.ts` adds only its input schema.

| Hint | A tool has it when |
| --- | --- |
| `readOnlyHint` | The call changes nothing in the hive, on disk or anywhere else. |
| `destructiveHint` | The call can end, cancel or discard something that is not the caller's own to set again: another session, a worker's terminal, open tasks, a worker's task memory. |
| `idempotentHint` | The same call again succeeds, answers the same and changes nothing more. A repeat that is refused does not count. |
| `openWorldHint` | The call reaches a system of the agent's choosing outside the hive. |

The protocol's defaults are the pessimistic ones (not read-only, destructive, open world), so no hint is left to them:
a read-only tool states `readOnlyHint` and `openWorldHint`, every other tool states all four. No tool has a `title`:
orders and docs name tools by their `name`.

| Tools | Read-only | Destructive | Repeatable | Outside |
| --- | --- | --- | --- | --- |
| `whoami`, `agents`, `bot_tools`, `channels`, `search`, `history`, `expand_digest`, `get_room`, `worker_templates`, `get_worker_capabilities`, `worker_match_suggest`, `get_handoffs`, `get_task`, `get_task_timeline`, `preview_task_claim` | yes | | | no |
| `send`, `set_capabilities`, `wait`, `create_channel`, `set_thread_status`, `invite`, `attach` | no | no | no | no |
| `subscriptions`, `assign_task`, `job_event`, `request_worker`, `worker_match_outcome`, `worker_match_override`, `ack_delivery`, `fetch_file`, `react` | no | no | yes | no |
| `join`, `clear_context` | no | yes | no | no |
| `room_event`, `release_worker`, `task_event` | no | yes | yes | no |
| `call_bot_tool` | no | yes | no | yes |

Why the six destructive ones: `join` with `resume` cuts off the earlier session of that name; `clear_context` tells a
worker to discard its task memory; `room_event` can archive a channel, which cancels its open tasks; `release_worker`
archives a worker and closes its terminal; `task_event` can cancel a task, and an accepted review archives a
task-bound worker; `call_bot_tool` runs a project bot's executable, and what that does is the bot's own.

Two things are left out on purpose:

- **Bookkeeping.** Every request records its caller's presence (`last_seen_at`, `online`) and its activity and traffic
  counters, which live in memory. A read-only tool does that and nothing else.
  `src/mcp/tool-annotations.test.ts` calls every read-only tool against a real server and compares the whole database
  before and after.
- **Mirrors the Human set up.** A message can be relayed to a project's Telegram group, and a brain with adaptive
  routing sends context to the advice service. Both go to services the Human chose, with hive content only, so they
  are not "open world". Only `call_bot_tool` reaches a system of the agent's choosing.

Adding a tool means adding its entry: `ToolName` is the key type, `src/mcp/tool-annotations.unit.test.ts` names the
destructive and open-world tools, and `src/mcp/role-visibility.test.ts` checks the annotations as a client receives
them.

### What hosts do with them

Checked on 2026-11-11 in the sources below. NOT RUN against an installed host: the active setup must stay untouched.

| Host | Use of the hints |
| --- | --- |
| Codex | In the default approval mode of an MCP server (`auto`), a call needs approval unless the tool is read-only, or is neither destructive nor open world; a missing hint counts as its pessimistic default ([`codex-rs/core/src/mcp_tool_call.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs)). Without annotations every Hivemind tool needed approval in that mode; with them, the six destructive ones do. |
| Claude Code | A read-only call may run side by side with other read-only calls, and plan mode goes by the same hint ([MCP docs](https://code.claude.com/docs/en/mcp)). |
| Cursor | No documented use ([MCP docs](https://cursor.com/docs/mcp)); approval follows its own allowlist. |

The annotations can only remove a question: no call that ran unasked before needs approval now.

Hivemind does not approve tools for a host: the Human decides. In Codex that is
`mcp_servers.hivemind.default_tools_approval_mode` (`auto`, `prompt`, `writes` or `approve`) and, for one tool,
`mcp_servers.hivemind.tools.<tool>.approval_mode` ([Codex MCP docs](https://developers.openai.com/codex/mcp)). A Codex
agent that must cancel tasks or release workers with nobody to ask needs one of those settings, as it did before.

## Size of the tool list

Every agent carries the answer to `tools/list` in its context for the whole session: each tool's description and input
schema. The schemas are about three quarters of it. The sizes below count each definition without its annotations,
which are for the client; the same test reports their bytes apart. Measured on 2026-11-11 with the MCP SDK's own client
(`src/mcp/role-visibility.test.ts` reports the sizes on every run):

| MCP process | Tools | Before | Now |
| --- | --- | --- | --- |
| No role | 37 | 46 658 bytes | 38 215 bytes |
| Brain | 36 | 45 301 bytes | 36 910 bytes |
| Worker | 23 | 31 535 bytes | 26 095 bytes |

The MCP process sends each input schema without two JSON Schema keywords that tell a model nothing it needs to form a
call (`src/mcp/lean-schema.ts`):

- `$schema`, the dialect, which was on every tool;
- a `pattern` next to a `format`: every UUID field carried a regex of about 170 bytes beside `format: "uuid"`. The
  format stays.

Everything else is sent as before: types, required fields, enums, the variants of `action`, `additionalProperties:
false` and a `pattern` that stands alone. Nothing changes in validation: the MCP process and the server check every
call against the same zod schemas. A client that validated a UUID against the regex before sending now learns of a bad
one from the server's answer.

The same test holds a budget per role, about 3% above these sizes. A new tool or a longer definition that passes it
fails the test, so the list grows on purpose and not unnoticed. Most of what remains is `task_event` (about 10 KB):
its `action` lists every shape, which models need to form the call.
