# Human upgrade and verification: agent orchestration

These steps are for Human **after reviewing and merging the PR stack**. Development did not run them against the
production installation. Never install a development Server.app beside the running production app: they share native
state, broker discovery and Keychain service names.

## Merge order

Merge the roadmap #266 and token-efficiency #275, then A1: #281 → #282 → #283, with #284's pending-identity branch
integrated before #285. The A2–A5 continuation is #286 → #287 → #288 → #289 → #290 → #291 → #292 → #293 → #294. Each continuation PR names its immediate stack base. Phase T is also merged into #291's branch.
The Phase 3 and T2 PR links will be added when their exact commits are qualified.

## Storage changes

| Version | Change |
| --- | --- |
| 32 (A1) | Per-project worker templates. |
| 33 (A1) | Pending identity reservations and single-use claim hashes. |
| 34 (A2) | Launch requests and native launcher command queue. |
| 35 (A3) | Per-brain launch mode, archived/reserved identity fields and request hashing. |
| 36 (A4) | Jobs, job request ledger, task job links and claim/resume launch kind. |
| 37 (A5) | Task cursor and saved launch lookup indexes; task data unchanged. |
| 38 (Phase 3) | Identity revisions/overrides, reserved name aliases, lifecycle log and capability editor attribution. |

The migration runner applies pending versions when the new server opens the database. Do not open a migrated home with
an older build; restore its matching backup instead. See [Storage and backup](storage-and-backup.md).

## Production upgrade, to be run later by Human

1. Finish or checkpoint ongoing work. Stop every Hivemind server and CLI operation using the production home; stop
   agent MCP clients so none reconnect during the upgrade.
2. Back up the **complete stopped `~/.hivemind` home**, including database/WAL/SHM, files, configuration and
   `launcher-queue.key` if present. Preserve the native `launcher-journal` directory alongside the matching backup
   when it exists. Preserve the existing Keychain; template secrets are not in the Node database.
3. Install the reviewed merged build and matching Mac/iPhone/iPad clients using the normal release procedure.
4. Start Hivemind Server.app once. Check migration/startup results before opening new launch requests.
5. Restart **every agent's MCP client**, then resume the intended identities. New tools, standing orders and role
   visibility require fresh MCP processes. Mail alone must never relaunch an agent.

If startup fails, stop all processes again and restore the complete matching backup before using an older build. Do not
mix a database with WAL/SHM files or encryption keys from another snapshot.

## Manual checks after installation

These checks require the installed native apps and real hosts; unit/browser fixtures cannot prove them.

- Define a project template with a Keychain secret and a low concurrent cap. A new brain defaults to Approval. Request
  a worker, receive the Mac native notification and approve/change template/reject from the Mac and iPhone/iPad cards.
  On iOS, foreground delivery is supported; background APNs delivery is not implemented. Reopening shows pending cards.
- Repeat the same request ID: one identity/task/launch remains. Test the cap, launch failure, expiry and explicit cleanup
  retry. Restart Server.app around a pending command and verify no duplicate process is launched. Never log secret values.
- A task-bound worker joins, creates its own worktree/branch and reports progress. Accept/cancel archives it, retains
  task history and closes its native session. Verify fixed workers coexist and receiving mail causes no auto-resume.
- Soft pause asks for a checkpoint and stops work while retaining the session. Hard pause waits for checkpoint/grace and
  closes the session. Resume uses the same identity and handoff; a failed/rejected resume remains paused. A saved
  checkpoint is a worker report, not proof that later unsaved work survived.
- Open project/global Tasks on Mac and iPhone/iPad: job counts, latest checkpoint, approvals, terminal, thread and brain
  DM draft. Byte counters are agent-wide API response bytes since server start, not model tokens or per-task usage.
- With queued mail, stop host wait/action progress while heartbeats continue: after the stall window the UI must show a
  stall hint. This verifies visibility; it does not fix or qualify an external host's MCP timeout behavior (#258).

- Open an agent panel: confirm inbox/receipts, activity age, checkpoint, byte counters, template settings source and
  lifecycle history. Rename a fixed agent; its old name resumes the same identity, new mentions use the new name and
  historical messages retain their original text. Change focus/seniority and verify stale launch settings do not reset
  them. Edit a capability card and confirm stale revisions are rejected.
- Resume a fixed agent with explicit host settings; Stop only a broker-verified session. Review Remove's task impact,
  including jobs losing a reviewer, and test optional Stop failure separately from removal. Native labels and existing
  Telegram topic titles may retain a former name until recreated.
