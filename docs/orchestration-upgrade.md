# Human upgrade and verification: agent orchestration

These steps are for Human **after reviewing and merging the PR stack**. Development did not run them against the
production installation. Never install a development Server.app beside the running production app: they share native
state, broker discovery and Keychain service names.

## Merge order

| Order | Phase | Pull requests |
| --- | --- | --- |
| 1 | Roadmap | [#266](https://github.com/maxcorrads/hivemind/pull/266) |
| 2 | Phase T | [#275](https://github.com/maxcorrads/hivemind/pull/275) |
| 3 | A1 | [#281](https://github.com/maxcorrads/hivemind/pull/281) → [#282](https://github.com/maxcorrads/hivemind/pull/282) → [#283](https://github.com/maxcorrads/hivemind/pull/283) → [#284](https://github.com/maxcorrads/hivemind/pull/284) → [#285](https://github.com/maxcorrads/hivemind/pull/285) |
| 4 | A2 | [#286](https://github.com/maxcorrads/hivemind/pull/286) → [#287](https://github.com/maxcorrads/hivemind/pull/287) → [#288](https://github.com/maxcorrads/hivemind/pull/288) |
| 5 | A3 | [#289](https://github.com/maxcorrads/hivemind/pull/289) → [#290](https://github.com/maxcorrads/hivemind/pull/290) |
| 6 | A4 | [#291](https://github.com/maxcorrads/hivemind/pull/291) → [#292](https://github.com/maxcorrads/hivemind/pull/292) |
| 7 | A5 | [#293](https://github.com/maxcorrads/hivemind/pull/293) → [#294](https://github.com/maxcorrads/hivemind/pull/294) |
| 8 | Phase 3 | [#295](https://github.com/maxcorrads/hivemind/pull/295) → [#296](https://github.com/maxcorrads/hivemind/pull/296) |
| 9 | T2 | [#297](https://github.com/maxcorrads/hivemind/pull/297) → [#298](https://github.com/maxcorrads/hivemind/pull/298) |

The final T2 launch/configuration slice is #298, based on #297. Every continuation PR names its immediate stack base. #284 is already integrated into #285; merge its pending-identity history before #285. Phase T is
also merged into #291's branch, and the roadmap history is included in A2. None of these PRs was merged by development.
Required Human review still applies to protected-main PRs even when all checks are green.

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

- Update each Codex profile's MCP `env_vars` to include `HIVEMIND_ROLE` alongside `HIVEMIND_TMUX_SESSION` (the generated
  `mcp-config --codex` block shows both). Generated launches set the role; a manual configuration may omit it and retain
  every tool. Do not hardcode one role into a config used for both brains and workers. Verify initial MCP tool discovery
  in each installed host after restarting its client; actual host versions were not exercised during development.

## Validation boundaries

Each continuation PR records its exact tested commit and full local check counts. Hosted CI runs Node22/24, coverage,
Chromium fixtures and macOS/iOS builds; CodeQL runs separately. Native Swift unit tests use fakes. Local browser tests
use mocked APIs with no production proxy. These checks do not prove installed-app notifications, Keychain/broker
integration, actual model-host behavior or production migration execution; use the manual list above after upgrading.
