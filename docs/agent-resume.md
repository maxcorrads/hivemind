# Agent resume

Resume belongs to Hivemind's integrated launcher. It restores each employee's last successful launch choices, not one
common model for the whole roster. The Hivemind employee ID, provider conversation ID and tmux label are different
identifiers; an employee name or terminal label cannot restore a provider transcript.

## Quick start

1. Launch an employee normally from **Launch agent** or a worker template. After its first successful join, Hivemind
   saves the selected software/alias, model, effort, CLI flags, workspace and profile environment for that employee.
2. When the employee is stopped, open **Resume same employees**, or its **Resume** action. Each card restores its own
   choices and, for Codex, Claude Code and Cursor CLI, selects **Resume original conversation** with the recorded ID.
3. Check the cards, include the employees you want and launch or copy the batch. Different clients/models can be resumed
   together. A rename does not lose the settings because they belong to the immutable employee ID.

The settings are saved on successful **join**, not when previewing, copying or starting a terminal. An unsuccessful launch
does not replace the previous settings. Explicit edits in the sheet apply to the next launch; after it joins, those become
the defaults. Stale browser preferences and later template changes do not replace the saved choices. Choosing `default`
restores that choice, not a snapshot of the provider's changing default model. Model changes made inside a CLI are not
tracked: Resume restores what was selected in Hivemind.

Each employee's launch editors stay disabled until its project's saved launch context loads. A loading failure keeps them
disabled and shows the error, so provisional browser defaults cannot replace that employee's configuration.

The advanced launch checkboxes reflect the employees' effective saved choices (a mixed state means they differ).
Changing a checkbox overrides that option for every employee shown in the sheet, including individual Copy actions;
untouched options keep each employee's saved value. These overrides last only for the open sheet and are saved for an
employee only after its next successful join, just like the other launch edits.

In the apps, selecting an OpenCode employee shows the optional OpenCode Go API key field even when the shared software
default is another client. The key goes only to selected OpenCode launches, never to copied commands or saved settings.
Removing the last eligible OpenCode employee from the selection (or changing its client) clears the field and its value.

Online/verified-running employees cannot be restarted here. Pending reservations, archived/removed identities and
task-bound workers keep their existing lifecycle controls. A browser cannot prove an offline employee's old process has
exited; check before launching. The native broker still checks terminal reuse. A terminal-start acknowledgement does not
prove successful transcript recovery or join.

Manual workers (including Human launches from templates) need only the Hivemind MCP binding and can launch when a bot
package, profile or registry is unavailable. Brains still require their bot instructions; the task queue retains its
stricter project-readiness check.

## Native conversations

Hivemind records IDs programmatically, without asking the model to discover IDs or read conversation files:

| Client | New conversation | Resume |
| --- | --- | --- |
| Codex | A `SessionStart` command hook reports `session_id` | `codex resume ID` |
| Claude Code | Hivemind assigns a UUID with `--session-id` | `claude --resume ID` |
| Cursor CLI (`agent`, `cursor-agent`, aliases) | `create-chat` returns a chat ID before the interactive launch | `agent --resume ID` |

Codex needs a version supporting inline `SessionStart` hooks, with hooks enabled and the Hivemind hook reviewed in `/hooks`.
Native trust and approvals are not bypassed. If capture is unavailable, join fails with an explicit diagnostic; no ID is
guessed. After trusting a previously skipped startup hook, restart/resume the CLI so its startup event runs again.
The hook definition is stable across launches; a Hivemind executable/path change may require review again.

Claude receives the per-launch Hivemind MCP binding. Codex receives that binding plus the hook through CLI configuration,
without editing the user's config files. Cursor uses its normally configured Hivemind stdio MCP server, but **does not
automatically forward the launch environment**. Run `hivemind mcp-config --cursor` against the same Hivemind instance and
merge its `hivemind` entry into the selected workspace's `.cursor/mcp.json` (or the selected profile's global config),
preserving other servers. It explicitly forwards `HIVEMIND_LAUNCH_TICKET`, `HIVEMIND_ROLE` and `HIVEMIND_TMUX_SESSION`
using Cursor's `${env:NAME}` interpolation. A workspace entry can shadow the global one, so check the effective binding.
Use the upgraded Hivemind MCP executable and restart the client; an older MCP process cannot enforce the new join check.
The generated tracked prompt requires `requireLaunchTracking=true` on join: a missing binding fails before creating an
employee or clearing an existing employee's saved settings. Do not remove that check to get past a setup failure.

Review Cursor's native MCP approval when prompted, using the same CLI/profile and launch environment. Cursor CLI
2026.10.01 includes the resolved environment in that approval: a new launch ticket can require approval again even if
the server path has not changed. An unattended launch can therefore stop awaiting native approval. Hivemind never calls
`mcp enable` automatically or enables blanket MCP approval. Do not persist a ticket in `mcp.json` or reuse an old ticket.
Cursor support concerns **CLI chats**, not IDE chat tabs.
Cursor's chat-creation and resume commands use the same alias, flags, working directory and profile environment.

Use the original installed CLI/alias and profile/home. Hivemind does not copy transcripts, credentials or accounts.
A missing provider session remains a CLI error: there is no silent `--last`, conversation picker or fresh-chat fallback.
Conflicting resume/fork selectors in extra CLI flags are rejected. Exact native recovery does not convert transcripts
between providers. Custom aliases must forward the generated arguments and environment.

## Existing employees and checkpoint recovery

Older launches have no automatic configuration/ID backfill. Legacy reported metadata can prefill model and effort, but
cannot reconstruct a custom profile or executable. Human can enter a known conversation ID and review the other choices
once; a successful tracked join records them for subsequent resumes. Do not guess IDs or scan unrelated transcripts.

**New conversation · recover Hivemind checkpoints** explicitly starts fresh with the same Hivemind identity. This is also
the recovery path after selecting another provider. The prompt asks for unfinished handoffs, paginated checkpoints and
current contracts before work resumes. Missing or unsaved context is not reconstructed automatically. Current stops,
permissions and completed work take precedence over old conversation instructions.

## Task-bound workers

Use task Resume, including the existing hard-pause/kill acknowledgements and launch approval. Once a worker has joined a
tracked launch, task Resume uses **that worker's saved launch snapshot**, not the current template's model, effort,
software, flags or environment. Template availability, capacity, task lifecycle and current secret access still gate the
operation. Secret values come from the native credential store, not a historical snapshot. Legacy workers without a saved
launch retain the old template-based checkpoint-recovery behavior; matching legacy native IDs may still be resumed.

## Storage and safety

Migration 41 stores legacy provider metadata. Migration 42 adds encrypted launch settings and single-launch capabilities.
Migration 43 fences prepared resumes against the employee's current session, even when no launch settings were saved.
Previously prepared, unbound resume commands must be prepared again after that upgrade; bound launches remain usable.
Only Human's project-scoped launcher API and the approved task queue prepare executable configuration. The MCP process
passes the capability automatically; a model's `nativeSession` cannot overwrite tracked launch choices. Binding settings
and joining happen atomically. Expired commands, mismatched identities/projects, duplicate fresh joins and prepared resumes
superseded by a newer join are rejected. Preparing/copying a command is not permission to perform its assigned work.

The Human launch context exposes only that project's settings. Agent rosters and ordinary UI snapshots omit them.
Configuration is encrypted using the private `launcher-queue.key`; protect it together with the database and do not delete
it during upgrades. Callback capabilities are stored as hashes. No transcripts, native API-key fields or Keychain values
are imported. Arbitrary environment values can nevertheless contain secrets: they are encrypted on the server but appear
in copied shell commands. Use the native secret fields instead. Unused prepared commands expire after 24 hours; copy again
if necessary. Untracked replacement joins clear the tracked association to avoid restoring a stale conversation.

Restarting only the MCP connection keeps the launch configuration and conversation association: explicitly join with
`resume=NAME` (the current or a former name). Only the identity already bound to the **current** launch can reconnect;
an initial join without a name cannot allocate a duplicate employee. A reconnect rotates the in-memory session key,
fences the previous MCP session and redelivers unacknowledged mail. No bearer credential is saved to disk. Superseded
launches and removed/archived identities remain blocked, and a hard-paused task still requires Human's task Resume.

Provider references: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Codex resume](https://developers.openai.com/codex/cli/reference/#codex-resume),
[Claude Code CLI](https://code.claude.com/docs/en/cli-reference),
[Cursor MCP configuration](https://cursor.com/docs/mcp),
[Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters).
