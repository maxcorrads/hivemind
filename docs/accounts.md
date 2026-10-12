# Accounts

An account is one named login of Codex or Claude that a launch of `codex` or `claude` can run under, instead of a
shell alias that points `CODEX_HOME` or `CLAUDE_CONFIG_DIR` somewhere else. Human orders each driver's accounts and
picks a policy; a launch or a worker template may pin one. HiveMind keeps paths, order and policy only. It never
stores, reads or shows a provider token: login stays a CLI command Human runs once in a terminal.

The design is [#319](https://github.com/maxcorrads/hivemind/issues/319); this page grows with its phases. Phase 0
([#320](https://github.com/maxcorrads/hivemind/issues/320)) fixes the names and rules below; phase 1
([#321](https://github.com/maxcorrads/hivemind/issues/321)) stores the [Catalog](#catalog); phase 2
([#322](https://github.com/maxcorrads/hivemind/issues/322)) lets a launch pick one
([Choosing an account](#choosing-an-account)); phases 3 and 4 ([#323](https://github.com/maxcorrads/hivemind/issues/323),
[#324](https://github.com/maxcorrads/hivemind/issues/324)) build the [Codex shadow](#codex-shadow) and the
[Claude shadow](#claude-shadow); phase 5 ([#325](https://github.com/maxcorrads/hivemind/issues/325)) reads each account's
[Usage](#usage). The rules live in `src/shared/accounts.ts` and, for the broker, HivemindKit's `LaunchAccount`. Both read
`src/shared/account-paths.vectors.json`, so the page and the app check paths and build variables the same way.
[Acceptance](#acceptance) maps #319's test plan to the tests.

## Decisions

Taken while splitting #319 into phases (2026-10-12). Where #319 says otherwise, this table wins.

| Topic | Decision |
| --- | --- |
| Catalog storage | SQLite, migration v41 (`agent_accounts`, `agent_account_policies`), revision rules as in `worker_templates`. |
| Who resolves an account | The Node server. The broker receives the resolved paths and never reads the catalog (`TerminalBrokerService` does not know `HIVEMIND_HOME`). |
| Empty catalog | A driver with no accounts launches exactly as today. |
| Account paths | Same shape for both drivers. `homePath` is the shared tree (`""` = the CLI default `~/.codex` / `~/.claude`). `shadowPath` is this account's own directory (`""` = a primary account). The variable is `shadowPath` if set, else `homePath` if set, else not set. A primary with an empty `homePath` sets nothing: `CLAUDE_CONFIG_DIR=~/.claude` set explicitly changes which `.claude.json` and keychain item Claude uses. |
| Aliases | Keep working. When `software` is in the codex/claude family (`softwareFamily`) but is not exactly `codex`/`claude`, and that driver has accounts, the Launch sheet and the template editor show a warning. Such a launch skips accounts. |
| Exhaustion | From usage snapshots only. Spikes 0.2/0.3 found no reliable limit-error source: Claude's `rate_limit` stop is shown next to the snapshot but not used by the policy, and Codex's limit errors cannot be tied to an account without reading the session. HiveMind does not read terminal output. |
| Usage storage | SQLite, migration v42 (`agent_account_usage`): one row per account, the last good snapshot and the last attempt ([Stored usage](#stored-usage)). |
| Balanced with partial data | Accounts without a snapshot are eligible but rank after accounts with one. When no eligible account has a snapshot: round-robin by `lastSelectedAt` (oldest first, `null` first, ties by order), marked stale. |
| Pin on an exhausted account | The pin wins (it skips the policy). The result carries a warning the UI shows. |
| Usage probe | Runs in Hivemind Server.app, on the Mac that launches. Snapshots go to Node over the signed launcher channel. Policy and dashboard read the same stored snapshot. |
| Copy-only launches (browser) | No account. The sheet says that accounts apply to launches from the apps. |
| Claude `~/.claude.json` | Confirmed by [Findings: Claude](#findings-claude): with `CLAUDE_CONFIG_DIR` set, Claude reads and writes `$CLAUDE_CONFIG_DIR/.claude.json` and never `~/.claude.json`. The swap in #319 and the "one Claude account at a time" limit are dropped. `.claude.json` is a private real file in each shadow, and parallel Claude accounts are allowed. |
| Variables an account controls | Codex: `CODEX_HOME`, `CODEX_SQLITE_HOME`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`. Claude: `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`. With an account, none of them may appear in the free-form environment or among the secret names. The broker sets the account's own variables and unsets the rest, because a login shell's `.zshrc` could export them and they override the directory's login ([Claude](#findings-claude), [Codex](#findings-codex)). |
| Codex shadow runs | `CODEX_HOME=<shadow>` and `CODEX_SQLITE_HOME=<absolute home>`. With the second variable, every SQLite database stays in the home and none is linked ([Findings: Codex](#findings-codex)). The shared `config.toml` must not set `cli_auth_credentials_store` to `keyring`, `auto` or `ephemeral`. Each shadow runs its own Codex daemon, as separate homes do today. |
| Prepare before login | The Accounts sheet asks Server.app to create the shadow and its links **before** Human runs the login command. A login on an empty folder would create real files that later conflict with the links. |
| Exact paths | Claude keys its keychain login to the exact `CLAUDE_CONFIG_DIR` string. Paths are stored and exported exactly: no trailing `/`, no `//`, no `.` or `..` segments. The broker expands only a leading `~/`. |

## An account

| Field | Rule |
| --- | --- |
| `id` | Stable id. Templates, launches and usage snapshots name this, never a path |
| `driver` | `codex` or `claude` |
| `label` | 1–80 characters, trimmed; shown in the pickers and in messages |
| `command` | Always the driver itself (`codex` or `claude`), never an alias |
| `order` | Position in the driver's list, from 0. Human reorders it |
| `homePath` | The shared tree. `""` is the CLI's default (`~/.codex`, `~/.claude`) |
| `shadowPath` | This account's own directory, where its login lives. `""` for a primary account, which logs in to `homePath` itself. Never the shared tree |
| `revision` | Bumped by every edit; an edit names the revision it started from |
| `lastSelectedAt` | Unix ms of the last launch that picked it, or `null`; balanced round-robin starts from the oldest |
| `createdAt`, `updatedAt` | Unix ms |

A driver has at most 8 accounts and one policy: `sequential` (use the first account until a quota window is used
up, then the next) or `balanced` (spread launches; prefer the most quota left in the window that resets first).

A path is `""` or written exactly as it will be exported: it starts with `/` or `~/`, has at most 1024 bytes, no
control characters, no trailing `/`, no `//` and no `.` or `..` segment. `accountPathProblem` gives the reason a
path is refused, and `LaunchAccount.validate()` refuses the same paths with the same words.

| Account | `homePath` | `shadowPath` | Login lives in |
| --- | --- | --- | --- |
| Codex, the default | `""` | `""` | `~/.codex` |
| Codex, a second login on the same sessions | `""` | `~/.codex_personal` | the shadow |
| Codex, its own sessions | `~/.codex-work` | `""` | `~/.codex-work` |
| Claude, the default | `""` | `""` | `~/.claude` |
| Claude, its own directory | `~/.claude-work` | `""` | `~/.claude-work` |
| Claude, a second login on the same transcripts | `""` | `~/.claude-personal` | the shadow |

Error codes the later phases answer with: `accounts_exhausted`, `account_pinned`, `account_unknown`,
`account_env_conflict`, `account_driver_mismatch` (`ACCOUNT_ERRORS`).

## Variables

A launch with an account gets these variables, values as stored (`accountEnvironment`); the broker expands a leading
`~/` with the user's home before it writes the launch file (`LaunchAccount.environment(home:)`):

| Account | Variables |
| --- | --- |
| Codex shadow | `CODEX_HOME=<shadowPath>`, `CODEX_SQLITE_HOME=<homePath, or ~/.codex>` |
| Codex primary | `CODEX_HOME=<homePath>` when it is set, otherwise none |
| Claude | `CLAUDE_CONFIG_DIR=<shadowPath, or homePath>` when one is set, otherwise none |

Each driver's controlled variables (`ACCOUNT_CONTROLLED_ENV`, `LaunchAccount.controlledNames`) belong to the account:

- Codex: `CODEX_HOME`, `CODEX_SQLITE_HOME`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`;
- Claude: `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_SECURESTORAGE_CONFIG_DIR`.

With an account, none of them may be set in the launch's environment variables or named as a template secret,
compared without case, even when the account itself sets no variable. `accountEnvironmentConflict` names the first
one: "`CODEX_API_KEY` is managed by the account Codex work; remove it." The broker sets the account's variables and
unsets the other controlled names, since a login shell could export them and a token variable outranks the
directory's login. `HOME` is never set.

Only Software that is exactly `codex` or `claude` takes an account (`accountDriverForSoftware`; an empty field is
`codex`). An alias such as `codex2` or `claude-work` still launches, without an account; when its driver has
accounts, `softwareAliasWarning` gives the hint the Launch sheet and the template editor show.

## Logging in

Each account logs in once, in a terminal on the Mac that launches (`accountLoginCommand`):

| Account | Command |
| --- | --- |
| Codex shadow | `mkdir -p <dir> && CODEX_HOME=<dir> CODEX_SQLITE_HOME=<home> codex -c cli_auth_credentials_store=file login` |
| Codex primary | `codex login`, or `CODEX_HOME=<home> codex login` for a home other than the default |
| Claude | `mkdir -p <dir> && CLAUDE_CONFIG_DIR=<dir> claude auth login`, or `claude auth login` for the default |

For example `mkdir -p ~/.codex_personal && CODEX_HOME=~/.codex_personal CODEX_SQLITE_HOME=~/.codex codex -c
cli_auth_credentials_store=file login`. A path with spaces or quotes is single-quoted after its leading `~/`, so the
shell still expands `~` to `$HOME`, as the broker does later: Claude then finds the keychain item it logged in with.
`-c cli_auth_credentials_store=file` keeps a Codex shadow's login in its own `auth.json` whatever the shared
`config.toml` says. A shadow is prepared by HiveMind before its login; a login into an empty folder creates real
files where the shared links belong.

## Catalog

Human keeps the catalog in the server's database, from migration v41: `agent_accounts` has one row per account, and
`agent_account_policies` one row per driver that has a chosen policy. Only Human changes it. Like the other Human
routes, a request with an `Authorization` header gets 403. Launches pick their account from it
([Choosing an account](#choosing-an-account)).

| Field | Column | Set by |
| --- | --- | --- |
| `id` | `id` | the server, a UUID at create |
| `driver` | `driver` | create only; an edit that names another driver gets 400 |
| `label` | `label` | create, edit |
| `order` | `position` | create (the end of the list), reorder, remove |
| `homePath` | `home_path` | create, edit |
| `shadowPath` | `shadow_path` | create, edit |
| `revision` | `revision` | 1 at create; +1 on each edit, on each reorder that moves the account, and on each remove that moves it up |
| `lastSelectedAt` | `last_selected_at` | a launch that picks the account (internal, no event) |
| `createdAt`, `updatedAt` | `created_at`, `updated_at` | create; `updatedAt` on each change |

`command` is not stored: it is always the driver. A driver with no policy row is `sequential`. A policy change names
the driver and the policy only; it has no revision check, so the last change wins.

Rules:

- At most 8 accounts per driver. The ninth is refused with 429.
- `label` is unique per driver (409). A non-empty `shadowPath` is unique across the catalog (409). At most one primary
  account (empty `shadowPath`) per driver and `homePath` (409).
- `shadowPath` cannot be the shared tree: the same as `homePath`, or the CLI default when `homePath` is empty (400,
  compared after Unicode NFC).
- Paths follow the rules in [An account](#an-account) and are checked on create and on edit (400).
- A refusal names the field or the rule. It never shows file contents or a token.
- An edit names the `expectedRevision` it started from; another current revision is 409. Omitted fields keep their
  value.
- Remove needs `revision` in the query (a missing or non-integer value is 400). While a worker template's `accountId`
  names the account, remove is refused with 409 `account_pinned`, and the message names those templates. Otherwise the
  account goes, and each later account in its driver's list moves up one place and gets a new revision.
- Reorder takes `ids`, which must list every account of the driver exactly once (400 otherwise). Positions become
  0…n−1, and each account whose position changes gets a new revision.
- Every committed change publishes one `accounts` realtime event after the commit. It carries no data; the open
  Accounts sheet refetches its list on it. A launch picking an account publishes nothing.

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/ui/accounts` | | `{accounts, policies, usage}`, `usage` as in [Stored usage](#stored-usage) |
| `POST /api/ui/accounts` | `AccountSpec` | the account, `201` |
| `PUT /api/ui/accounts/order` | `{driver, ids}` | `{accounts, policies}` |
| `PUT /api/ui/accounts/policy` | `{driver, policy}` | `{accounts, policies}` |
| `POST /api/ui/accounts/resolve` | `{driver, accountId?, record?}` | `{selection}`, see [Choosing an account](#choosing-an-account) |
| `PUT /api/ui/accounts/:id` | `{expectedRevision, label?, homePath?, shadowPath?}` | the account |
| `DELETE /api/ui/accounts/:id?revision=N` | | `{ok: true}` |

Errors: `400` for a bad body or path, a changed driver, a reorder with the wrong ids, or an unknown policy; `404` for an
unknown account id; `409` for a stale revision, a duplicate label, shadow or primary, and a pinned remove; `429` for a
ninth account in one driver; `403` for an `Authorization` header.

### Sheet

Settings → **Accounts** opens the sheet, after **Adaptive routing**. It has one section per driver:

- **Policy**: a Sequential / Balanced control. Each policy has one line saying what it does, as in
  [An account](#an-account).
- The ordered list: label, home path and shadow path (`default` and `none` when empty), **Up**, **Down**, **Edit**
  and **Remove**. Remove asks first. It says HiveMind forgets the account and that its folders and login stay where
  they are.
- **Add account**, disabled at 8 accounts: label, home path and shadow path, with the path problem shown under the
  field. Once both paths are valid, the login command for them appears with a **Copy** button and the line "Log in
  once in a terminal; HiveMind never stores tokens." Editing an account does not show the command.
- **Prepare**, in the apps only, on each account: Hivemind Server.app builds a shadow's folder and links before its
  login, and only checks a primary's login
  ([Preparing an account](terminal-broker.md#preparing-an-account)). The row then shows "Ready", "Not logged in" or
  the error text, which names the fix. After a successful Prepare the row shows the account's login command with
  **Copy**. Editing either path hides the status. In a browser the sheet says "Prepare needs the Mac app".
- Under each account, its quota windows and the age of their read ([In the Accounts sheet](#in-the-accounts-sheet)).

A server error shows as text in the sheet. An `accounts` event refetches the list.

### Login commands

Each account logs in once, in a terminal on the Mac that launches; the commands are in [Logging in](#logging-in). The
sheet shows the command for the paths typed in **Add account**, before a label is typed.

For a Codex or Claude shadow, **Prepare** first, then run the command the row shows: the login then finds the links in
place, as [Logging in](#logging-in) describes.

## Choosing an account

A launch of `codex` or `claude` runs under one account, chosen when its session starts. The Launch sheet and a worker
template's **Start** ask the server with `POST /api/ui/accounts/resolve` (`{driver, accountId?, record?}`, answering
`{selection}`); a brain's approved request is chosen the same way in the launch queue. The rules are in
`selectAccount` (`src/shared/account-selection.ts`). A driver with no accounts launches exactly as before, and so does
a Software that is not exactly `codex` or `claude` (see Aliases below).

**Pins.** A launch can pin one account: the Launch sheet's **Account** (anything but Auto) or a template's **Account**.
A pin skips the policy and wins even when its account is used up. The launch then runs and, on the Mac, the sheet
shows "<label> is used up until <ISO time>", or "<label> is used up" when no reset time is known; off the Mac the
sheet gives way to the sessions as before. A pin to an account that has been removed does not launch.

**Policies.** Without a pin, the driver's policy chooses among its accounts that are not used up, in Human's order:

- **Sequential** takes the first account. It stays on it until it is used up, then takes the next one, and returns to
  the first after its reset.
- **Balanced** scores each account with a usable snapshot as `100 − usedPercent` of the window that resets first. When
  no window has a future reset, it scores the most used window instead. The highest score wins, and ties go to the
  earlier account. An account without a snapshot is never picked while another eligible account has one.
- **Round-robin** is balanced's fallback when no eligible account has a snapshot: the account picked longest ago wins,
  an account never picked comes first, and ties go by order. Its picks always read "usage unknown".

A launch that picks an account records the pick, so balanced round-robin moves on to the next account.

**Used up.** An account is used up while one of its windows is at 100% and its reset is unknown or still ahead, or while
its recorded limit reset (`limitResetAt`) is still ahead. A window whose reset has passed counts as reset, so sequential
returns to the first account after it. When every account is used up, the launch does not start (see the table below).
The message names the first reset: "Every Codex account is used up. The first resets at <local time> (in <countdown>)."
The time is left out when no reset is known.

**Until usage is known.** The policy reads the stored snapshots of [Usage](#usage), the same ones the Accounts sheet
shows. An account with no snapshot yet is never used up: sequential can take it, balanced ranks it after every account
with a snapshot, and its pick reads "usage unknown". A snapshot older than ten minutes (`USAGE_STALE_MS`) also reads
"usage unknown", but it still scores and can still be used up. A snapshot with no windows, such as an API-key login's,
counts as no snapshot.

**Reuse.** The account is chosen when a session is created. A launch that reuses a running session keeps the account
that session started with. In the Launch sheet, **Resume same employees** gives an account only to employees whose
session is not running. While one is running, the sheet says "This session keeps the account it started with. Terminate
it and launch again to switch." The broker does the same for a reused session: it checks no account and writes nothing
([Launch environment](terminal-broker.md#launch-environment)).

**Copy-only launches.** **Copy**, **Copy all**, **Copy command** and **Reserve and copy** pick no account: the copied
command runs without one, in whatever terminal it is pasted into. A browser picks no account either and keeps copying as
before. Where its driver has accounts, the Launch sheet says "Accounts apply to launches from the apps."

**Aliases.** Only a Software that is exactly `codex` or `claude` takes an account; an empty Software is `codex`.
An alias such as `codex2` or `claude-work` still launches, but without an account, even when its driver has accounts.
The Launch sheet and the template editor then show a hint, for example "codex2 launches without a Codex account:
accounts apply only when Software is exactly codex." The hint never disables Launch or Save.

**What a launch shows.**

| Pick | In the apps: Launch sheet and template **Start** | A brain's request, or a queued template launch |
| --- | --- | --- |
| An account | Launches. On the Mac the sheet shows "Account: <label>", the pin's warning, and "usage unknown" when stale | Launches under it |
| Used up | Does not launch, with the message above. **Start** reserves no worker | Stays queued with "Every Codex account is used up until <local time>", as a launch without a worktree does, and is tried again on each poll |
| Pin removed | Does not launch: "That account was removed; pick another." | Stays queued: "The pinned account no longer exists" |
| Conflict | Launch is disabled and the conflict shows, as in [Variables](#variables) | Stays queued with the conflict message |
| No accounts | Launches as before | Launches as before |

## Codex shadow

A second Codex login on one home's threads. The shadow links the shared entries (sessions, history, config, writer
locks) from the home and keeps its own `auth.json`. The account's `homePath` is the home and its `shadowPath` is the
shadow folder ([An account](#an-account)). Hivemind Server.app builds the shadow when the account is prepared and checks
it again before each launch. It deletes, moves and chmods nothing, and it never reads a login.

### Layout

Only the entries the home has are linked. The writes are the shadow's links, the shadow folder, and the home's
`sessions` and `thread-writer-locks` folders, which are created (0700) before the links when missing. A second run on a
good shadow changes nothing.

| Class | Names | In the shadow |
| --- | --- | --- |
| Shared | `sessions`, `archived_sessions`, `session_index.jsonl`, `history.jsonl`, `thread-writer-locks`, `rollout-migrations`, `external_agent_session_imports.json`, `attachments`, `generated_images`, `visualizations`, `tui-thread-reference-capabilities`, `config.toml`, `AGENTS.md`, `AGENTS.override.md`, `hooks.json`, `prompts`, `skills`, `rules`, `memories`, `plugins`, `pets`, `.sandbox_migration`, `.personality_migration`, `mcp-oauth-locks`, `.credentials.json`, and `<profile>.config.toml` (any name matching `^[A-Za-z0-9_-]+\.config\.toml$`) | A link to the home's entry. A name the home does not have is not linked |
| Private | `auth.json`, `installation_id`, `models_cache.json`, `version.json`, `cache`, `.tmp`, `tmp`, `shell_snapshots`, `log`, `app-server-control`, `app-server-daemon`, `packages`, `ipc`, `process_manager` | Real, kept by the shadow. Never linked |
| Home only | `<name>_<N>.sqlite`, also with `-wal`, `-shm` or `-journal` (`^[a-z][a-z0-9_]*_[0-9]+\.sqlite(-wal\|-shm\|-journal)?$`); `.sqlite-maintenance.lock`; `db-backups` | Never. A real one is a conflict, because Codex keeps these in the home |
| Ignored | names ending in `.tmp`, containing `.tmp-` or `.bak`, starting with `.tmp`, and `.DS_Store` | Skipped. Never linked, never a conflict |
| Other | any name in none of the lists | Fine when it is in one tree only. A conflict when it is in both, as a real file or a link |

### The two variables

A launch under a Codex shadow sets two variables, with a leading `~/` expanded by the broker ([Variables](#variables)):

- `CODEX_HOME=<shadowPath>`, the shadow, which holds its own `auth.json`;
- `CODEX_SQLITE_HOME=<homePath, or ~/.codex>`, the shared home. Every database stays there and is never linked or copied.

### Prepare, then log in

1. In **Settings → Accounts**, use **Add account** with the shared home as `homePath` (empty for `~/.codex`) and the
   folder as `shadowPath`.
2. Click **Prepare** on its row. It works in the apps only. Hivemind Server.app checks the shared `config.toml`, creates
   the shadow folder (0700) when it is missing, and links the shadow. The row then shows **Ready** when the shadow's
   `auth.json` is a regular file, **Not logged in** when it is not, or the error text with its fix.
3. After a successful Prepare the row shows the login command. Click **Copy** and run it in a terminal on the same Mac:

   ```sh
   mkdir -p <shadow> && CODEX_HOME=<shadow> CODEX_SQLITE_HOME=<home> codex -c cli_auth_credentials_store=file login
   ```

Prepare comes first because Codex creates files on its first run in a home, login included. A login into a folder whose
links are not in place yet leaves real files where the links belong, and they conflict later. A launch checks the shadow
again; with no login it is refused with the command above, and nothing runs.

### Shared config

The shared `config.toml` must not set `cli_auth_credentials_store` to `keyring`, `auto` or `ephemeral`. Hivemind Server.app reads its
lines up to the first table header, and refuses a shadow on that home when one of them sets any of these values. The login
command passes `-c cli_auth_credentials_store=file`, which applies to that login only. The fix is to remove the line or
set it to `file`. The setting is shared by every account on that home, the primary included. With `file`, Codex reads
`auth.json` and not the keychain, so a primary whose login is in the keychain has to log in again.

### Errors and fixes

A launch that fails here refuses only its own item, with `internal` and `launches[<i>].account: <message>`; the other
items start. Prepare shows the same message on the row, without the prefix.

| Message | Fix |
| --- | --- |
| "`<home>` must be an existing folder, not a symlink." | The shared home is missing or is a symlink. Run `codex` once to create `~/.codex`, or set `homePath` to a real folder. |
| "`<shadow>` does not exist yet. Prepare the account in the Accounts sheet, then log in with `<login command>`." | A launch found no shadow folder. Click **Prepare** on the row, then launch again. |
| "`<shadow>` must be a folder, not a symlink or a file." | Move that entry out of the way and Prepare, or choose another `shadowPath`. |
| "`<shadow>` is the shared home itself; a shadow needs a folder of its own." | The shadow leads to the home folder, for example `/Users/<you>/.codex` with an empty `homePath`, or through a symlinked parent folder. The catalog compares the typed paths only, so choose a folder that is not the home. |
| "`<link>` is a real file; HiveMind shares it from `<home>`. Move it away, then launch again." | A shared name is real in the shadow, or a link to anywhere else; usually a copied home. Move it out of the shadow (to a folder outside both homes if it holds threads), then Prepare or launch again. The home's copy is the one used. |
| "`<path>` should not be here: Codex keeps its databases in `<home>` (CODEX_SQLITE_HOME). Move it away." | A database, a `-wal`/`-shm`/`-journal` file, the lock or `db-backups` is in the shadow (real or a link), usually from a copied home or an earlier run. Move it out of the shadow. |
| "Unknown Codex file `<name>` in both homes; HiveMind's shadow layout needs an update." | The name is in both trees (in the shadow as a real file or a link) and is in no list. `ShadowLayout.codex` needs it, shared or private: a HiveMind code change. Until then, move the shadow's copy out of the way. |
| "`<shadow>` has no login yet. Run `<login command>` to log in." | Log in with the row's command, then launch again. |
| "`<home>/config.toml` sets cli_auth_credentials_store = `<value>`; shadow accounts need `file` (or no setting)." | Remove the line or set it to `file`, as in [Shared config](#shared-config). |
| "Cannot link `<link>` to `<target>`", "Cannot create `<path>`", "Cannot read `<path>`", each with the system's reason | The Mac user cannot write there, or the volume refuses. Fix the folder's permissions or the volume, then Prepare. |
| "Codex thread `<id>` is already open in another process. Close it there, or start a new session." (`launches[<i>].command`) | A `codex resume <id>` or `codex exec resume <id>` launch with an account found the thread's writer lock held by another process. Without an account nothing is checked. Close the thread there, or start a new session. `--last`, names and `fork` are not checked. Codex refuses a second writer by itself. |
| "Cannot check `<path>`: <reason>" (`launches[<i>].command`) | The thread's lock folder in the shared home cannot be read or locked. Fix its permissions, then launch again. |

### Known replacements of a link

Codex replaces a link in a shadow in one known case. Deleting a thread rewrites `session_index.jsonl` through a temp file
and a rename, which puts a real file where the shared link was, and the next launch refuses it ("is a real file" above).
Move the shadow's copy out of the way and launch again. The home's `session_index.jsonl` keeps its old content. Database
recovery also replaces a link, but it cannot happen in a shadow, because its databases stay in the home. A write to the
shared `config.toml` through a shadow's link changes it for every account on that home.

### Daemons

Each shadow runs its own `codex app-server` daemon. Its `app-server-control` and `app-server-daemon` are private, as each
separate home's already are. A shared daemon would run the shadow under the primary's login.

### Turning an existing home into a shadow

An existing separate home, such as a `~/.codex2` that an alias sets as `CODEX_HOME`, can stay a primary or become a
shadow of the shared home.

- **Stay a primary.** Set its `homePath` to that folder and leave `shadowPath` empty. Its threads and databases stay
  where they are, separate from the shared home's threads.
- **Become a shadow.** First move out of that folder everything the layout shares (`sessions`, `archived_sessions`,
  `history.jsonl`, `session_index.jsonl`, `thread-writer-locks`, `config.toml` and the other shared names above), and its
  databases (`*_N.sqlite` with their `-wal`, `-shm` or `-journal`, `.sqlite-maintenance.lock`, `db-backups`). Put them in
  a folder outside both homes. Moving them into the shared home would add those threads to it. Leave `auth.json` and the
  other private names: the shadow keeps its own login, so an existing file login still counts. Then add the account with
  that folder as `shadowPath`, Prepare it, and launch `codex` under that account ([Choosing an
  account](#choosing-an-account)). Stop using the alias for that folder: it sets only `CODEX_HOME`, not
  `CODEX_SQLITE_HOME`, so Codex would create its databases in the shadow and the next launch would refuse them.

## Claude shadow

A second Claude login on one shared tree's transcripts. The shadow links the transcripts, history, file history, pastes,
plans and tasks from the shared tree and keeps its own login, settings and live-session state. The account's `homePath`
is the shared tree and its `shadowPath` is the shadow folder ([An account](#an-account)). Hivemind Server.app builds the
shadow when the account is prepared and checks it again before each launch. It deletes, moves and chmods nothing, and it
never reads a login.

### Layout

A shared name is linked when the shared tree has it. Five folders are created in the shared tree (0700) when missing, so
those are always linked. A second run on a good shadow changes nothing.

| Class | Names | In the shadow |
| --- | --- | --- |
| Shared | `projects`, `history.jsonl`, `file-history`, `paste-cache`, `plans`, `tasks` | A link to the shared tree's entry. `projects`, `file-history`, `paste-cache`, `plans` and `tasks` are always linked; `history.jsonl` only when the shared tree has it |
| Private: login and settings | `.claude.json`, `.claude.json.lock`, `.config.json`, `.credentials.json`, `backups`, `settings.json`, `settings.local.json`, `settings.json.bak`, `policy-limits.json`, `policy-limits.json.stamp.json`, `remote-settings.json`, `mcp-needs-auth-cache.json` | Real, kept by the shadow. Never linked |
| Private: sessions and daemon | `sessions`, `session-env`, `shell-snapshots`, `daemon`, `daemon.log`, `daemon-auth-status.json`, `daemon-auth-cooldown`, `jobs`, `debug`, `state`, `ide` | Real, kept by the shadow. Never linked |
| Private: plugins and caches | `plugins`, `skills`, `chrome`, `telemetry`, `feedback`, `feedback-bundles`, `statusline-command.sh`, `cache`, `stats-cache.json`, `gh-pr-status-cache.json`, `.last-cleanup`, `.last-update-result.json`, `usage-data`, `downloads` | Real, kept by the shadow. Never linked |
| Ignored | `.DS_Store` | Skipped. Never linked, never a conflict |
| Other | any name in none of the lists | Kept private: real in the shadow, never linked, never an error |

Only the shared row is linked. A shadow does not see the shared tree's own `CLAUDE.md`, `agents`, `commands`, `skills` or
`plugins`; it starts without them and keeps its own.

### Login check and command

An account is logged in when its folder has a regular file `.credentials.json`, or a regular file `.claude.json` that
parses as a JSON object with a top-level `oauthAccount` key. Hivemind looks only at that key, never at its value. A
primary account is checked the same way in its shared tree. Log in once, in a terminal on the same Mac:

```sh
mkdir -p <shadow> && CLAUDE_CONFIG_DIR=<shadow> claude auth login
```

### Why `CLAUDE_CONFIG_DIR`, never `HOME`

With `CLAUDE_CONFIG_DIR` set, Claude reads and writes `<shadow>/.claude.json` and never `~/.claude.json`, and its keychain
item is keyed by the same folder. The login, settings and live-session state therefore follow the folder. `HOME` is never
set: it would move every `~/` for the session, including the git and ssh settings other tools read, and Claude does not
need it. Claude still reads two things from the real home: `~/.claude/ide/` (IDE lockfiles, read only) and
`~/.config/anthropic` (global Anthropic profiles). Per Claude's docs, separate folders do not keep two Console sign-ins
apart.

### Exact path for the keychain

Claude keys its keychain login to the exact `CLAUDE_CONFIG_DIR` string: the item is `Claude Code-credentials-<first 8 hex
of the sha256 of that string>`. It does not resolve symlinks or trim a trailing `/`, so another spelling of the same folder
is another item, and the account looks logged out. Hivemind therefore exports the shadow exactly as the account stores it,
with only a leading `~/` expanded, and Prepare and each launch refuse a shadow with a trailing `/` or a symlink in it: "Use
the real path of `<dir>`: Claude keys its login to the exact folder name." `<dir>` is the path to store instead. A
primary's `homePath` is exported the same way and is not checked for a symlink, so log in with the same string the
account stores.

### cleanupPeriodDays

Each config folder runs Claude's retention sweep over the shared `projects/`, with its own `cleanupPeriodDays` and its own
`.last-cleanup`. So the shadow's `settings.json` and the shared tree's must set the same top-level `cleanupPeriodDays`; a
missing file or key means the default. Otherwise the smallest value deletes every account's transcripts. Hivemind reads only
this key in each file. It refuses a shadow whose two values differ, and a `settings.json` that is not a JSON object. Prepare
gives a new shadow that has no `settings.json` the shared tree's value: it writes a `settings.json` (0600) holding only
`cleanupPeriodDays`. A launch never writes it.

### Variables and project settings

With an account, Claude gets `CLAUDE_CONFIG_DIR=<shadowPath, or homePath>` when one is set ([Variables](#variables)). Its
controlled names are `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and
`CLAUDE_SECURESTORAGE_CONFIG_DIR` (undocumented; it overrides the keychain's hash input). The broker unsets the ones the
account does not set. These variables and an `apiKeyHelper` outrank the folder's login.

Before a launch with an account, Hivemind reads `<cwd>/.claude/settings.json` and then `<cwd>/.claude/settings.local.json`.
A missing or unreadable file is no check. The item is refused when a file sets a top-level `apiKeyHelper`, or has an `env`
key named as a controlled name (without case): "`<file>` sets `<KEY>`, which overrides the account `<label>`. Remove it from
that file." Only key names are read, never values, and no value is logged. The account's own `settings.json` in its folder
is not checked, so keep the same keys out of it too.

### Same API

Share a tree only between first-party Claude logins. Never share one with a login that goes through a proxy or OpenRouter
(see [pingdotgg/t3code#2365](https://github.com/pingdotgg/t3code/issues/2365)).

### One writer per transcript

A launch of `claude` with an account that resumes a transcript is refused while another process has it open. A launch
without an account runs as it always did, and Claude decides. `--resume <id>`, `-r <id>` or `--resume=<id>` is refused when a live session has that id. `--continue` or `-c` is
refused when a live session has the launch's folder, compared by real path. New sessions are always allowed, and so is
`--fork-session`. `--resume` with no id opens Claude's picker and is not checked.

Claude keeps live sessions in `sessions/<pid>.json` in each config folder, and sees only its own. Hivemind reads only the
`pid`, `sessionId`, `procStart`, `pidDomain` and `cwd` of each `sessions/[0-9]*.json`, in the shared tree and in each shadow
it knows, and never opens `sessions/*.key`. A record is live when `pidDomain` is `darwin`, `kill(pid, 0)` succeeds, and the
process start time equals `procStart`. The broker never reads the catalog itself: it learns a shadow when an account of it
launches or is prepared, and from the [usage probe](#usage-probe), which passes it the catalog's Claude accounts at start
and every 5 minutes. After Hivemind Server.app restarts, a shadow counts again from the probe's first round.

### Parallel accounts

Parallel Claude accounts are allowed. Each has its own `.claude.json`, keychain item, settings and `sessions/`, so two can run
at once. The `~/.claude.json` swap and the "one Claude account at a time" limit of #319 are dropped ([Decisions](#decisions)).

### Prepare, then log in

1. In **Settings → Accounts**, use **Add account** with the shared tree as `homePath` (empty for `~/.claude`) and the folder
   as `shadowPath`, written as its real path.
2. `cleanupPeriodDays` must match between the shared tree's `settings.json` and the shadow's. For a new shadow with no
   `settings.json`, Prepare writes one holding only the shared tree's value. If the shadow already has a `settings.json`,
   set the same value there yourself.
3. Click **Prepare** on its row. It works in the apps only. Hivemind Server.app checks the path and `cleanupPeriodDays`,
   creates the shadow folder (0700) and links the shared names. The row then shows **Ready** when the shadow has a login, or
   **Not logged in** when it does not, or the error text with its fix. A primary account only gets its login checked; for
   the default primary (empty `homePath`) that is `~/.claude.json` in the Mac home, where Claude keeps it without
   `CLAUDE_CONFIG_DIR`.
4. After a successful Prepare the row shows the login command. Click **Copy** and run it in a terminal on the same Mac.

Prepare comes first so the shared names are links before anything runs in the folder. A login into a folder whose links are
not in place yet can leave a real `projects/` or `history.jsonl` there, and that conflicts later. A launch checks the shadow
again; with no login it is refused with the command above, and nothing runs.

### Errors and fixes

A launch that fails here refuses only its own item; the other items start. A shadow fails with `internal` and
`launches[<i>].account: <message>`, a project setting with `bad-message` and the same prefix, and an open session with
`internal` and `launches[<i>].command: <message>`. Prepare shows the same message on the row, without the prefix.

| Message | Fix |
| --- | --- |
| "`<home>` must be an existing folder, not a symlink." | The shared tree is missing or is a symlink. Create `~/.claude` or set `homePath` to a real folder. |
| "`<shadow>` does not exist yet. Prepare the account in the Accounts sheet, then log in with `<login command>`." | A launch found no shadow folder. Click **Prepare** on the row, then launch again. |
| "`<shadow>` must be a folder, not a symlink or a file." | Move that entry out of the way and Prepare, or choose another `shadowPath`. |
| "`<shadow>` is the shared home itself; a shadow needs a folder of its own." | Choose a folder that is not the shared tree. A symlinked parent folder can lead to it too. |
| "Use the real path of `<dir>`: Claude keys its login to the exact folder name." | Set `shadowPath` to the real path shown, then Prepare. A login made under another spelling is not found there. |
| "`<shadow>/settings.json` has cleanupPeriodDays `<a>` but `<home>/settings.json` has `<b>`. Set the same value: each account cleans the shared transcripts with its own value." | Set the same top-level `cleanupPeriodDays` in both files, or leave it out of both, then Prepare or launch again. |
| "`<path>` is not a readable JSON object; fix it before launching a shadow account." | Fix that file so its top level is a JSON object, then launch again. |
| "`<link>` is a real file; HiveMind shares it from `<home>`. Move it away, then launch again." | A shared name (for example `projects` or `history.jsonl`) is real in the shadow, usually from a copied folder. Move it out of the shadow, then Prepare or launch again. The shared tree's copy is the one used. |
| "`<shadow>` has no login yet. Run `<login command>` to log in." | Log in with the row's command, then launch again. |
| "`<file>` sets `<KEY>`, which overrides the account `<label>`. Remove it from that file." (`launches[<i>].account`) | Remove that key from the project's `.claude/settings.json` or `settings.local.json`, then launch again. |
| "Claude session `<id>` is already open in another process (account `<label>`)." (`launches[<i>].command`) | Close that session where it runs, or start a new session. |
| "Cannot check `<path>`: <reason>" (`launches[<i>].command`) | The session folder cannot be read. Fix its permissions, then launch again. |
| "Cannot link `<link>` to `<target>`", "Cannot create `<path>`", "Cannot read `<path>`", each with the system's reason | The Mac user cannot write there, or the volume refuses. Fix the folder's permissions or the volume, then Prepare. |

## Usage

Each account's quota windows, as its provider reports them: per window the used percent and the reset time, and in the
Accounts sheet a countdown to that reset. Nothing forecasts how fast the rest will be used. Hivemind Server.app reads
them on the Mac that launches ([Usage probe](#usage-probe)) and posts them to the server, which keeps the last good read
of each account ([Stored usage](#stored-usage)). The [policy](#choosing-an-account) and the
[Accounts sheet](#in-the-accounts-sheet) read that same stored snapshot, so they cannot disagree about which account is
used up. No read costs quota, and Hivemind itself reads no login (phase 5,
[#325](https://github.com/maxcorrads/hivemind/issues/325)).

| Driver | Source | Has data |
| --- | --- | --- |
| Codex | `codex app-server`, with the requests `account/read` and `account/rateLimits/read` ([Findings: Codex](#findings-codex)) | On every round, for an account that is logged in. An API-key login has plan `api-key` and no window |
| Claude | 1. The [status-line tap](#claude-status-line-tap) of the sessions Hivemind launches with the account | After a session's first API response, until its windows go [stale](#stale-and-unknown) |
| Claude | 2. `cachedUsageUtilization` in the account's `.claude.json`, which Claude itself writes (undocumented) | While its `accountUuid` is the login's and it is at most 8 days old; an older one than 10 minutes shows as stale, with its age |

Claude has no headless read: `/usage` runs only inside a session, and `claude -p` does not run it. So a Claude account
has no data before its session's first API response, with no Hivemind session and no cache of the last 8 days, or with
an API-key login. That is not a failure: the probe sends nothing for it, and its row says how the numbers come.

| Source | Key | Label |
| --- | --- | --- |
| Claude | `five_hour`, `seven_day` | "Session (5 h)", "Week" |
| Claude, cache only | `seven_day_<family>` | "<Family> (week)", for example "Opus (week)" |
| Codex | `<limitId>.primary`, `<limitId>.secondary` | By the window's length: 300 min "5 h", 1440 "Day", 10080 "Week", 43200 "Month", else "<n> min". The main bucket comes first; each other bucket's label starts with its `limitName`. At most 8 windows |

### Claude status-line tap

Claude has no headless usage read, but it gives a status-line command `rate_limits` on its input once a session has had
an API response ([Findings: Claude](#findings-claude)). So a Claude session that Hivemind launches with an account records
that input for its account. It costs no quota and reads no login.

| File, under `~/Library/Application Support/Hivemind/accounts/` | Written by | Holds |
| --- | --- | --- |
| `statusline-tap.sh` (0600) | Hivemind Server.app, before each launch | The tap, run with `/bin/sh` |
| `<id>/settings.json` (0600) | Hivemind Server.app, before each launch | `statusLine` and the `StopFailure` hook below, nothing else |
| `<id>/statusline.json` (0600) | The tap, each time the status line runs | Claude's last status-line input for the account, as given |
| `<id>/limit-error` (0600) | The tap, on a `rate_limit` stop | The time, in Unix seconds |

The folders are 0700, and `<id>` is the account's id; an id that is not a plain file name (letters, digits, `-`, `_`) gets
no tap.

**The settings.** Before a created session of a Claude account starts, after its other checks and its shadow, the broker
writes `<id>/settings.json` and the script, and puts `HIVEMIND_CLAUDE_SETTINGS=<that file>` in the launch file. The launch
command of exactly `claude` carries `${HIVEMIND_CLAUDE_SETTINGS:+--settings} ${HIVEMIND_CLAUDE_SETTINGS:+"$HIVEMIND_CLAUDE_SETTINGS"}`,
so Claude gets `--settings <file>` only then: a copied block run outside such a session, an alias (`claude-work`) or a
launch without an account gets nothing. The session's shell exports the variable, like `CLAUDE_CONFIG_DIR`, so a block run
there after Claude exits records for the same account. A launch never sets the variable itself: `HIVEMIND_` names are
refused in its environment. When the files cannot be written, the session starts without `--settings` and the broker log
says why. The file holds:

- `statusLine`: `/bin/sh <tap> status <account folder> <own settings>`, where the own settings are the account's
  `settings.json`: `<shadowPath, else homePath, else ~/.claude>/settings.json`.
- `hooks.StopFailure`: one entry with matcher `rate_limit` that runs `/bin/sh <tap> limit-error <account folder>`. Claude
  merges it with the other hooks.

**The tap.** `status` saves its input as `statusline.json`, then reads only `statusLine.command` from the own settings
(`plutil`, each time) and runs it with `/bin/sh -c` on the same input, in Claude's folder and environment. It prints that
command's output and exits with its status, so the account's own status line shows as before. With no such command it
prints nothing. `limit-error` writes the time and keeps nothing of its input. Each write goes to a temporary file in the
account folder, then a rename, so a reader never sees half a file. A missing account folder writes nothing. The tap writes
nothing anywhere else.

**Limits.** The tap's `statusLine` replaces every other one, and only the account's own is chained: a project's
`statusLine` (`.claude/settings.json`, `.claude/settings.local.json`) is not shown in these sessions. `disableAllHooks`,
`allowManagedHooksOnly`, a managed `statusLine` or an untrusted workspace turn the tap off. A session that Hivemind did not
launch with an account records nothing. A `rate_limit` stop is a suspected limit, not a proof: the windows decide.

### Usage probe

While its server runs, Hivemind Server.app reads every account's quota windows: once at start, then 5 minutes after each
round (`UsageProbeService`). A round fetches the catalog from `GET /api/launcher/accounts`, reads the accounts one at a
time in catalog order, then posts every snapshot in one `POST /api/launcher/usage`. Both requests are signed like the rest
of the launcher channel, and a server that does not prove its secret is asked nothing. The round also gives the broker the
catalog's Claude accounts, so the [open-transcript check](#one-writer-per-transcript) sees a shadow after a restart.

**Codex.** A shadow is first prepared as before a launch (its links, no new folder, a login required). When that fails
the snapshot says "Shadow not ready: use Prepare in the Accounts sheet" and nothing runs. Then `codex app-server` runs in
the login shell the sessions run (`/bin/zsh -lic`, in the home folder), so it is the `codex` a session finds. After the
startup files the shell sets only the account's [variables](#variables), unsets the other controlled names and execs
`'codex' app-server`. The probe writes the requests of [Findings: Codex](#findings-codex) and keeps stdin open until
the replies to requests 2 and 3 arrive, in either order, or 20 s pass. Then it closes stdin, and ends codex if it has not
exited 2 s later. stderr is discarded, and stdout goes only to the parser. The errors are "Not logged in" and "Usage read
failed"; an API-key login is plan `api-key` with no windows.

**Claude.** Two files, neither of them a login:

- the tap's `<id>/statusline.json`, as of its modification time;
- `cachedUsageUtilization` in the account's `.claude.json`, as of its `fetchedAtMs`. The file is
  `<shadowPath, else homePath>/.claude.json`, or `~/.claude.json` for a primary with neither. The cache counts only when
  its `accountUuid` is the login's (`oauthAccount.accountUuid`) and it is at most 8 days old. Claude refreshes it rarely,
  so it is usually stale; it is sent with its own `fetchedAtMs`, and its windows that have reset since are left out.

The status line is used when it is newer than the account's last snapshot. Otherwise, and before the first snapshot, the
newer of the two is used, as long as it is not older than that snapshot, so a round never goes back in time. The last
snapshot is the last one the server took since Server.app started. When neither file has data, the snapshot says "No
recent Claude usage data". That happens before a session's first API response, for an account with no Hivemind session
and no recent cache, and for an API-key login. A good read's plan is `subscription`, since only a subscription has rate
limits. The tap's `<id>/limit-error` sets `limitErrorAt`.

**Snapshots.** A snapshot's time is when its windows were true, so an idle session's status line reads as old as it is,
and is stale after `USAGE_STALE_MS`. An error snapshot carries one of the fixed messages above, never a command's output
or a file's contents, and the server keeps the previous windows. A round that fails to post is read again in the next one.

### Stored usage

The server keeps one row per account in `agent_account_usage`, from migration v42 (`AccountUsageStore`,
`src/server/account-usage.ts`). Removing an account removes its row.

| Field (`AccountUsage`) | Column | Holds |
| --- | --- | --- |
| `snapshot` | `captured_at`, `source`, `plan`, `windows` | The last good read: when its windows were true, the driver, `subscription`, `api-key` or `unknown`, and its windows. `null` until the first good read |
| `lastAttemptAt`, `lastError` | `last_attempt_at`, `last_error` | The last read, good or not, and its fixed error. A good read clears the error |
| `limitErrorAt` | `limit_error_at` | The last `rate_limit` stop the Claude tap saw. A read without one keeps it. Shown, never used by the policy |
| `limitResetAt` | `limit_reset_at` | A recorded limit's reset, which the policy honours. No source sets it yet |

A read with an `error` keeps the previous windows, capture time and plan. Each stored read publishes an `accounts` event
after the commit, so an open Accounts sheet refetches.

Server.app uses two routes of the signed [launcher channel](terminal-broker.md#launcher-channel), which answer an
unsigned request as `GET /api/launcher/next` does:

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/launcher/accounts` | | `{accounts}`: each catalog entry as a launch carries it (`{id, driver, label, homePath, shadowPath}`), nothing more |
| `POST /api/launcher/usage` | `{snapshots}`: at most 16 `UsageSnapshot`s, 64 KiB in all | `{ok: true}` |

A snapshot is strict (`usageSnapshotSchema`): `accountId`, `capturedAt` (Unix ms), `source`, `plan`, at most 8 `windows`
of `{key, label, usedPercent, resetsAt}` with distinct keys (`usedPercent` used, 0–100; `resetsAt` Unix ms or `null`),
`error` (`null` or at most 200 characters) and `limitErrorAt`. An unknown key or a bad value is 400, naming the field
paths only; an unknown account is 404. One post is one transaction: a refusal keeps none of its snapshots.
`GET /api/ui/accounts` answers each account's `usage` with the catalog; an account that has never been read has no
entry.

### Stale and unknown

A snapshot is stale when its capture time is more than ten minutes ago (`USAGE_STALE_MS`). The capture time is when the
windows were true, not when they were posted: an idle Claude session's status line, or Claude's cache, is as old as
Claude last wrote it. A stale snapshot is shown with its age and "stale", never as live. The policy still scores it and
an exhausted window still counts, but its pick reads "usage unknown". An account with no snapshot is "unknown" in the
sheet and never used up ([Choosing an account](#choosing-an-account)). The probe sends no Claude read older than the
account's last snapshot, so a round never moves an account back in time.

### In the Accounts sheet

Each account row of **Settings → Accounts** shows its usage under it (`web/AccountUsage.tsx`):

- "Usage as of <age>", with " · stale" for a stale snapshot; before the first read, "No usage yet" and how the numbers
  come (for Claude: from sessions Hivemind launches with the account, after their first reply);
- per window: its label, what is left as a bar (full when nothing is used, empty when the window is used up) and as
  "<n>% left", and "Resets <local time> · in 2 h 14 min" ("in 3 d 4 h" for a week; "reset passed" once it is behind;
  "No reset time" when the provider gives none);
- per window, a forecast: "At this pace it runs out <local time> · in 1 h 28 min", "At this pace it lasts until the
  reset", or "Used up until the reset" (see below);
- "API key: no plan window" for an `api-key` plan, and "No quota window reported" for a good read without windows;
- "Last read failed: <error>" while the last read failed, next to the previous windows;
- " · Limit error at <local time>" next to the snapshot when the Claude tap saw a `rate_limit` stop, so a real limit can
  be told from a stale login ([anthropics/claude-code#39198](https://github.com/anthropics/claude-code/issues/39198)): a
  limit error while every window is far from 100% suggests the login or a passing error, not a used-up quota. Logging
  in again stays a manual step.

Ages and countdowns are drawn again every 30 s; an `accounts` event refetches the numbers.

The forecast (`src/shared/usage-forecast.ts`) is a straight line: the window's average pace from its start (its reset
minus its length, `windowMs`, which Codex reports and Claude's keys imply) to the read's time, carried on to 100%. It
knows nothing of bursts or quiet hours. It is left out while less than 5% of the window, or 10 minutes, has passed, when
the window's length or reset is unknown, and when the read is older than the window.

### What never appears

No token, `auth.json` or `.credentials.json` body, keychain item, email or MCP setting reaches a snapshot, a log line, an
HTTP answer, a stored row or the sheet. The parsers decode only the keys above: `rate_limits`; `cachedUsageUtilization`
and `oauthAccount.accountUuid`, which is compared and dropped; the reply ids, `account.type` and the rate-limit buckets
of Codex. The probe sends fixed error messages, and the tap's `limit-error` keeps only a time. The server refuses a
snapshot with an unknown key and names no value. `src/server/account-redaction.test.ts` and
`macos/Tests/HivemindKitTests/AccountRedactionTests.swift` plant fake secrets in fake homes and payloads and check every
one of these surfaces.

## Acceptance

#319's test plan, line by line. Every test uses fakes (fake homes under a temp folder, fake `codex` and `claude`
runners), so none needs a login.

| #319 test plan | Covered by |
| --- | --- |
| Two Codex accounts share session files and keep different `auth.json` files. A copied full home is rejected. | `ShadowHomeTests`: `freshShadowGetsItsLinksAndTheHomeFoldersFirst`, `theLoginsOfThePrimaryAndTheShadowAreNeverTouched`, `aCopiedHomeIsRefusedAndLeftAsItWas`, `aRealSessionsFolderInTheShadowIsAConflict`, `aRealDatabaseInTheShadowIsAConflict`; `BrokerAccountTests`: `aPreparedAndLoggedInCodexShadowLaunchesAndItsConfigIsReadOnlyToTheFirstTable` |
| Two Claude accounts share `projects/` and keep different `.credentials.json` files. A second launch against a live transcript is refused. | `ShadowHomeTests`: `aClaudeShadowSharesTheSixNamesAndKeepsItsLoginAndSettingsReal`; `ClaudeLiveSessionsBrokerTests`: `resumingASessionLiveUnderAPreparedShadowFailsOnlyItsItem`, `aShadowsLaunchSeesTheSharedTreesSessionsAndNothingOfItRuns`, `continuingInTheFolderOfALiveSessionFailsAndANewSessionThereStarts` |
| A second Claude account does not start while another Claude process is running (`~/.claude.json` swap). | Dropped ([Decisions](#decisions)): each account keeps its own `.claude.json`, so parallel accounts are allowed. `ClaudeLiveSessionsBrokerTests`: `aSecondAccountStartsANewSessionWhileAnotherAccountsSessionIsLive`; `ShadowHomeTests`: `aClaudeShadowSharesTheSixNamesAndKeepsItsLoginAndSettingsReal` (`.claude.json` stays real) |
| Sequential uses account 1 until its window is exhausted, then account 2, and returns to account 1 after the reset. | `src/shared/account-selection.test.ts`: "sequential uses the first account…", "a past reset is not exhausted"; `src/server/accounts-http.test.ts`: "the policy and the exhausted set agree on stored snapshots…" |
| Balanced picks the account with more remaining percent; equal remaining follows the configured order. | `src/shared/account-selection.test.ts`: "balanced picks the account with the most quota left…", "balanced ties go by order…", "with no snapshots, balanced round-robins…" |
| A pinned template ignores the policy. | `src/shared/account-selection.test.ts`: "a pin ignores the policy", "a pin on an exhausted account wins…"; `src/server/launcher-channel.test.ts`: "a Codex template launch runs under the policy's account or its pin…"; `web/template-launch.test.tsx`: "in the apps, Start under the template's pinned account…" |
| Resuming a tmux session does not change `CODEX_HOME` or `CLAUDE_CONFIG_DIR`. | `BrokerAccountTests`: `aReusedSessionKeepsItsAccountAndWritesAndRunsNothing`; `web/launch-sheet-accounts.test.tsx`: "an employee whose session still runs keeps its account…" |
| The dashboard shows used percent, reset time and countdown, and labels a stale snapshot with its age. | `web/account-usage.test.tsx` (fixed clock): all four tests; `src/server/accounts-http.test.ts` for the stored snapshot both read |
| Logs and UI snapshots contain no token, `auth.json` body or keychain secret. | `src/server/account-redaction.test.ts` (usage post, Human routes the sheet renders, launches, every table); `AccountRedactionTests` (parsers, a probe round, a refused post, a shadow launch's journal, logs and files); `ClaudeUsageTests.parsedWindowsHoldNoEmailMcpValueOrUuid`, `CodexUsageTests.parsedResultHoldsNoEmail` |

Manual checks, on the Mac with real logins, after the apps are installed; the fakes cannot prove what the CLIs do:

- **Codex.** Add a Codex shadow, **Prepare**, run its login command, then launch `codex` once under each account and
  `codex resume` a thread of one under the other. Both `auth.json` files stay where they were and differ. Within 5
  minutes each row shows its windows; compare them with `/status` in each session.
- **Claude.** Same with a Claude shadow and `claude --resume`. Run both accounts at once. After one answer in a session
  the row shows "Session (5 h)" and "Week" as `/usage` does, and the account's own status line still shows. An account
  with no session says "No usage yet", unless Claude's cache of the last 8 days has a window still running.
- **Dashboard without the apps.** Start a server with a secret of 64 lowercase hex characters (any other value is
  ignored): `HIVEMIND_HOME=$(mktemp -d) HIVEMIND_INSTANCE_SECRET=<secret> npx tsx src/cli.ts serve --port 7520`. Add
  accounts in the sheet, post signed snapshots to `POST /api/launcher/usage` with that secret (as `launcherSignature` in
  `src/server/launcher-channel.ts` signs), then check the bars, the countdowns, "stale" after ten minutes and "Limit
  error at".

## Findings: Claude

Spike 0.2: Claude Code 2.1.296 on macOS, 2026-10-12 ([full report and parser
fixtures](https://github.com/maxcorrads/hivemind/issues/320#issuecomment-6123057980)). Every run used a fresh
`mktemp -d` config directory under `env -i`, with a timeout; from real directories only entry and JSON key names were
read, with no login and no prompt. Code quotes come from the minified bundle, where function names change between
versions, so each names a literal to search for.

**`.claude.json`.** With `CLAUDE_CONFIG_DIR` set, Claude uses `$CLAUDE_CONFIG_DIR/.claude.json` and nothing reads
`~/.claude.json`.

- `CLAUDE_CONFIG_DIR=<tmp> claude auth status --json` exits 1, prints `{"loggedIn": false, "authMethod": "none", …,
  "configDirectory": "<tmp>"}` and creates `<tmp>/.claude.json`, `.claude.json.lock` and `backups/`.
- A sentinel `$HOME/.claude.json` under a fake `HOME` kept its atime through `auth status` and a full interactive start.
- Code (search `` .claude${ ``): `` `.claude${suffix}.json` `` joined to `process.env.CLAUDE_CONFIG_DIR || homedir()`.
- Still read outside the directory: `~/.claude/ide/` (IDE lockfiles, read-only) and the global Anthropic profiles in
  `~/.config/anthropic`; per the docs, separate directories do not keep two Console sign-ins apart.
- An explicit `CLAUDE_CONFIG_DIR=$HOME/.claude` uses `~/.claude/.claude.json`, not `~/.claude.json`.

**Keychain and the login marker.** The keychain service is `Claude Code-credentials-<first 8 hex of sha256(the exact
CLAUDE_CONFIG_DIR string, NFC)>`, or `Claude Code-credentials` with the variable unset.

- No realpath and no trailing-slash trimming: an existing login's item matched the hash of its expanded `~/…` path,
  and the same path with a trailing `/` names another item. HiveMind must export the exact string the login used
  (absolute, no trailing `/`, not through a symlink, never moved), or the account looks logged out.
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` (undocumented) overrides the hash input. API-key logins use `Claude Code[-<hash8>]`
  (no `-credentials`) or `primaryApiKey` in `.claude.json`. When the Keychain refuses a write, the login goes to
  `<dir>/.credentials.json` (mode 0600).
- No file's existence alone means "logged in": `.claude.json` appears even after a logged-out `auth status`. The
  marker is a top-level `oauthAccount` key in `<dir>/.claude.json` (key check only; logout clears it), or an existing
  `<dir>/.credentials.json`.
- Stronger checks that read no secret: `security find-generic-password -s "Claude Code-credentials-<hash8>"` (exit 0
  found, 44 not), or `CLAUDE_CONFIG_DIR=<dir> claude auth status --json` (`loggedIn`, no quota, but it rewrites
  `.claude.json`).
- `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper` and `CLAUDE_CODE_OAUTH_TOKEN` outrank the directory's
  login: a launch with an account unsets them and refuses them in its environment.

**Config directory layout.**

| Class | Names |
| --- | --- |
| Shared transcripts | `projects`, `history.jsonl` (appended under a lock, safe through a symlink), `file-history`, `paste-cache` (history references pastes by hash), `plans`, `tasks` |
| Private per login | `.claude.json`, `.claude.json.lock`, `.config.json`, `.credentials.json`, `backups`, `settings.json`, `settings.local.json`, `settings.json.bak`, `policy-limits.json`, `policy-limits.json.stamp.json`, `remote-settings.json`, `mcp-needs-auth-cache.json`, `daemon-auth-status.json`, `daemon-auth-cooldown`, `skills` (account-synced), `plugins` (absolute paths into its own directory), `chrome`, `telemetry`, `feedback`, `feedback-bundles`, `statusline-command.sh` |
| Private per process | `sessions`, `session-env`, `shell-snapshots`, `daemon`, `daemon.log`, `jobs`, `debug`, `state`, `ide`; session-keyed when present: `uploads`, `dev-mods` |
| Cache | `cache`, `stats-cache.json`, `gh-pr-status-cache.json`, `.last-cleanup`, `.last-update-result.json`, `usage-data`, `downloads` |

Each shadow runs Claude's retention sweep over the shared `projects/` with its own `cleanupPeriodDays`
(`.last-cleanup` is per directory), so every shadow's `settings.json` needs the primary's value; otherwise the
smallest one deletes every account's transcripts. Proposed shadow layout: the shared row is linked; everything else,
dotfiles, names starting with `daemon` and unknown names stay private (real in the shadow, never linked, logged once).
A name becomes shared only through an explicit list change.

**Usage.** The status-line JSON carries `rate_limits.five_hour` and `rate_limits.seven_day`, each with
`used_percentage` (0–100) and `resets_at` (Unix seconds).

- Docs: present "only for claude.ai Pro and Max subscribers, or behind a Claude apps gateway…, and only after the first
  API response in the session". A window may be absent and is dropped once its `resets_at` passes. Team and
  Enterprise are unverified; API-key logins carry no `rate_limits`. A payload without it is ambiguous, so the plan
  comes from the login marker or `auth status --json` `authMethod`.
- A `statusLine` passed with `--settings` replaces the user's (verified), while hooks from `--settings` merge
  (verified). A tap must chain to the user's own command; a project-scope `statusLine` is lost even then. It needs a
  live session and one API response, costs no quota and re-runs after each assistant message (300 ms debounce).
  `disableAllHooks`, `allowManagedHooksOnly` and an untrusted workspace switch it off.
- There is no headless `/usage`: no subcommand, and `-p` does not run it (the text could reach the model and spend
  quota). No hook input carries usage numbers.
- Undocumented cache: `cachedUsageUtilization` in `<dir>/.claude.json`, `{fetchedAtMs, accountUuid, utilization:
  {five_hour|seven_day|seven_day_opus|seven_day_sonnet|…: {utilization 0–100, resets_at ISO}|null}, limits: […]}`.
  Written at most once a minute, trusted by Claude for up to an hour, dropped on an `accountUuid` mismatch, cleared
  on logout. The file also holds `mcpServers` (may contain secrets) and `oauthAccount` (personal data): extract only
  that key; never store or log the file.
- Recommended: the status-line tap through `--settings`, recording only `rate_limits` and the capture time, plus a
  `StopFailure` (`rate_limit`) hook as a "suspected exhaustion" signal. Fallback: `cachedUsageUtilization` when its
  `accountUuid` matches and `fetchedAtMs` is under an hour old, stale after `USAGE_STALE_MS`. No active probing.

**Limit errors.** Claude shows `You've hit your session limit · resets 3:45pm` (and weekly, Opus and Sonnet
variants) or `API Error: Request rejected (429)`; interactive sessions wait and continue on their own. Without
reading the terminal HiveMind can observe the `StopFailure` hook with matcher `rate_limit` (input `error`,
`error_details`, `last_assistant_message`), the `Notification` types `quota_auto_resume_*`, and `used_percentage`
reaching 100. Whether quota exhaustion and a transient 429 both arrive as `rate_limit` is unverified: treat
`StopFailure` as suspected and confirm it from the numbers.

**Live sessions.** `sessions/<pid>.json` holds `cwd`, `entrypoint`, `kind`, `messagingSocketPath`, `name`, `pid`,
`pidDomain`, `procStart`, `sessionId`, `startedAt`, `status`, `updatedAt`, `version`… and is removed on exit.
`sessions/<pid>.<sha256>.key` is a secret: never read it. `session-env/<id>/` outlives the process and says nothing
about liveness. `sessions/` is per config directory, so Claude cannot see a process under another shadow. The
broker's check:

1. For each account directory (the primary and every shadow), read `sessions/[0-9]*.json`: `pid`, `sessionId`,
   `procStart`, `pidDomain`, `cwd`.
2. A record is live when `kill(pid, 0)` succeeds, `pidDomain` is `darwin` and `procStart` equals
   `TZ=UTC LC_ALL=C ps -o lstart= -p <pid>` with spaces squeezed (Claude's own guard against pid reuse).
3. A transcript id is live when a live record has that `sessionId`.
4. `--continue`/`-c` takes the newest transcript in `projects/<cwd>`, with every non-alphanumeric character of the
   cwd replaced by `-`: resolve it and check it, or refuse when a live record has the same realpath `cwd`. Paths
   compare by realpath.

## Findings: Codex

Spike 0.3: codex-cli 0.162.1, read from the source at tag `rust-v0.162.1` (paths below are under `codex-rs/`),
checked on macOS 2026-10-12 ([full report and probe
fixture](https://github.com/maxcorrads/hivemind/issues/320#issuecomment-6123125814)). Live runs used only
`codex app-server` with `CODEX_HOME=$(mktemp -d)` on fake primary/shadow pairs, never logged in; the only network
calls were unauthenticated 401s. From `~/.codex` only entry names were read.

**Headless rate limits.** `account/rateLimits/read` is what the TUI sends for `/status`.

- Params `{"excludeResetCreditDetails": true}`; leave out `supportsLunaReserve`, which records an experiment exposure.
- Response `{rateLimits: Snapshot, rateLimitsByLimitId?: {<limitId>: Snapshot}, ordinaryUsageAllowed?, …}`, with
  `Snapshot = {limitId, limitName, primary: Window|null, secondary: Window|null, planType, rateLimitReachedType, …}`
  and `Window = {usedPercent: int 0–100 (used, not remaining), windowDurationMins: int|null, resetsAt: unix
  seconds|null}`.
- Schema: `codex app-server generate-json-schema --out <dir>` (`ClientRequest.json`,
  `v2/GetAccountRateLimitsResponse.json`). Sources: `protocol/src/protocol.rs:2421`,
  `app-server-protocol/src/protocol/v2/account.rs:760`, the TUI call `tui/src/app/background_requests.rs:815–827`,
  the backend call `app-server/src/request_processors/account_processor.rs:1189–1280`.
- The TUI labels windows by length (`tui/src/chatwidget/rate_limits.rs:109–128`): about 300 min "5h", 1440 "daily",
  10080 "weekly", about 30 days "monthly".
- Stdio, one JSON object per line: send `initialize` with `{"clientInfo": {...}}` first (`initialized` is optional;
  anything earlier gets `-32600 "Not initialized"`). Keep stdin open until the reply arrives, since on EOF the server
  drops pending requests. Replies can come out of order: match by `id` and ignore notifications.
- No TTY needed. Unauthenticated, the whole process takes about 0.15 s; authenticated latency (one GET to the usage
  backend) is unverified.
- Errors: `-32600 "codex account authentication required to read rate limits"` (not logged in, seen live),
  `-32600 "chatgpt authentication required to read rate limits"` (API-key login, from the source),
  `-32603 "failed to fetch codex rate limits: …"` (backend failure).
- The plan comes from `account/read` `account.type` (`chatgpt` or `apiKey`), which also returns the email: the
  parser drops it. Nothing else prints the plan windows: there is no `status` subcommand, `codex exec --json` emits
  no rate limits and `account/usage/read` is token usage. `codex login status` exits 0 logged in and 1 not, without
  reading `auth.json`.

The probe sends, with a 20 s timeout:

```jsonl
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"hivemind_usage_probe","title":"HiveMind usage probe","version":"1"}}}
{"method":"initialized"}
{"id":2,"method":"account/read","params":{"refreshToken":false}}
{"id":3,"method":"account/rateLimits/read","params":{"excludeResetCreditDetails":true}}
```

For the report's fixture the expected parse is plan `subscription`; `codex.primary` "5 h", 42, 1791820800000;
`codex.secondary` "Week", 17, 1792252800000; `codex_other.primary` "codex_other", 88; no email anywhere. Exhausted:
`usedPercent` 100, `rateLimitReachedType: "rate_limit_reached"`, `ordinaryUsageAllowed: false`.

**`cli_auth_credentials_store`.** `file` (the default, `CODEX_HOME/auth.json`), `keyring`, `auto` or `ephemeral`
(`config/src/types.rs:133–146`, `config/defaults.toml:6`); an invalid value is refused with the list.

- Precedence: managed requirements (MDM), then `-c`, then `config.toml`.
- Keyring item: service "Codex Auth", account `cli|<first 16 hex of sha256(canonical CODEX_HOME)>`
  (`login/src/auth/storage.rs:243–257`).
- Only `file` gives a shadow its own `auth.json`. The shared `config.toml` must not set `keyring`, `auto` or `ephemeral`; check it
  before adding a shadow. `-c cli_auth_credentials_store=file` works per invocation, for example on `codex login`.
- `CODEX_ACCESS_TOKEN` (every front-end) and `CODEX_API_KEY` (exec, doctor, mcp) override the file login
  (`login/src/auth/manager.rs:1500–1538`). `forced_login_method` and `forced_chatgpt_workspace_id` in the shared
  `config.toml` apply to every account.

**Shadow layout.** `~/.codex` had 67 entries.

| Class | Names |
| --- | --- |
| Shared: conversation state | `sessions`, `archived_sessions`, `session_index.jsonl`, `history.jsonl`, `thread-writer-locks` (writer locks; shared with `sessions`), `rollout-migrations`, `external_agent_session_imports.json`, `attachments`, `generated_images`, `visualizations`, `tui-thread-reference-capabilities` |
| Shared: user config and content | `config.toml` (config writes follow symlinks), `AGENTS.md`, `AGENTS.override.md`, `<profile>.config.toml`, `hooks.json`, `prompts`, `skills`, `rules`, `memories`, `plugins`, `pets` |
| Shared: markers and MCP OAuth | `.sandbox_migration`, `.personality_migration`, `mcp-oauth-locks` (the keychain key is server + URL, not `CODEX_HOME`), `.credentials.json` (MCP OAuth fallback, not the Codex login) |
| Private: login and account caches | `auth.json`, `installation_id`, `models_cache.json`, `version.json`, `cache` |
| Private: per process | `.tmp`, `tmp`, `shell_snapshots`, `log`, `app-server-control`, `app-server-daemon`, `packages`, `ipc`, `process_manager` |
| SQLite (home only) | `state_5`, `thread_history_1`, `goals_1`, `queue_1`, `memories_1`, `memories_v2_1`, `logs_2` (`.sqlite` with `-wal`/`-shm`), `.sqlite-maintenance.lock`, `db-backups` |
| Used only by other tools | `.codex-global-state.json*`, `sqlite/`, `browser`, `computer-use`, `chrome-native-hosts-v2.json`, `node_repl`, `dictation-history`, `transcription-history.jsonl`, `vendor_imports`, `code-review-plugin`, `*.bak-*` |

- First run on a fresh home creates `.sandbox_migration`, `.tmp`, `tmp`, `installation_id`, `skills`,
  `shell_snapshots`, every `*_N.sqlite` with sidecars, `thread-writer-locks`, and `sessions` after the first turn.
  Links not in place before the first run (the login included) become real files that conflict later.
- SQLite through a symlink is safe: it resolves the link and puts `-wal`/`-shm` next to the target, so both paths
  share one lock (verified with Python and with codex); WAL with a 5 s `busy_timeout` (`state/src/sqlite.rs:356–392`).
  Better: `CODEX_SQLITE_HOME=<absolute home>` on shadow runs keeps every database, `.sqlite-maintenance.lock` and
  `db-backups` in the home whatever their version suffix (verified); it must be absolute
  (`core/src/config/mod.rs:273`). The `_N` suffixes are compile-time constants, so a bump creates a new file.
- A dangling directory link breaks codex: `thread/start` fails with "File exists (os error 17)" (verified). Deleting a
  thread rewrites `session_index.jsonl` by temp file and rename (`rollout/src/session_index.rs:99–102`), and database
  corruption recovery recreates the database (`state/src/runtime/recovery.rs:186–200`, avoided by
  `CODEX_SQLITE_HOME`): both replace a link with a real file.
- Each Codex home runs its own `codex app-server --managed-daemon` with an updater; every separate home already runs
  one. A shadow gets its own through its private `app-server-control` / `app-server-daemon`; sharing them would run
  the shadow on the primary's daemon and login. `--no-daemon` turns this off for interactive commands.
- Proposed layout: link the shared rows and the pattern `^[A-Za-z0-9_-]+\.config\.toml$`; keep the private rows real;
  never let `^[a-z][a-z0-9_]*_[0-9]+\.sqlite(-wal|-shm|-journal)?$`, `.sqlite-maintenance.lock` or `db-backups` appear
  in a shadow (a real one is a conflict); ignore `*.tmp`, `*.tmp-*`, `.tmp*`, `*.bak*`, `.DS_Store`. An unknown name
  is a conflict when real in both trees and fine in one. Create `sessions` and `thread-writer-locks` in the home
  before linking. Logged in means `auth.json` is a regular file; never read it.

**Live sessions.** An open thread holds an exclusive `flock` on `<CODEX_HOME>/thread-writer-locks/<threadId>.lock`
(`rollout/src/writer_lock.rs:43–105`). Codex's own probe: `flock(LOCK_EX)` on `.coordination.lock`; `open(<uuid>.lock,
O_RDWR)` without `O_CREAT` (ENOENT: not live); `flock(LOCK_EX|LOCK_NB)` (EWOULDBLOCK: live); unlock and close
everything. `lsof -t -- <file>` is a read-only alternative. Verified across a shared `thread-writer-locks`: with a
thread open in process A, process B's `thread/resume` got `-32600 "thread … already has an active writer"`. Codex
already protects itself (the TUI falls back to a read-only view), so a HiveMind check only makes the refusal clearer.
Resume forms: `codex resume <uuid|name>`, `codex resume --last`, `codex exec resume <uuid|name>`, `codex exec resume
--last`; `codex fork` makes a new thread and never conflicts.

**Limit errors.** The backend answers 429 `usage_limit_reached` with `resets_at` (unix seconds) and Codex does not
retry (`codex-api/src/api_bridge.rs:181–217`, `protocol/src/error.rs:419`). The message is "You’ve hit your usage
limit. … try again at 3:45 PM." (curly apostrophe, local time). Without reading the terminal it shows as app-server
notifications (`error` with `codexErrorInfo: "usageLimitExceeded"`, `turn/completed` with status failed), exit code 1
in exec mode, `task_complete.error.codex_error_info == "usage_limit_exceeded"` plus `token_count` events with
`rate_limits` in the rollout JSONL, and `thread_turns` in `thread_history_1.sqlite`. Attributing one to an account
needs the launching account, so v1 stays snapshot-only.
