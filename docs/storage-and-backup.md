# Storage, backup and restore

## Where data lives

All runtime state is under `~/.hivemind/` (or `HIVEMIND_HOME`): `hive.db` (plus its `hive.db-wal` / `hive.db-shm` sidecars while running), `files/` (attachment blobs), `pending-sends/` (the local send retry journal) and optional configuration such as `telegram.json`, `adaptive-routing.json` and plugin registrations. Agent downloads go to `<cwd>/.hivemind-inbox/`. Nothing in those paths belongs in git.

Brains and workers have no stored credentials: their session keys live only in memory (see [Identity lifecycle](identity-lifecycle.md)). Legacy `identities/`, `identities-v2/` or `last-join.json` files from earlier releases are no longer read.

## Backing up and restoring local storage

Stop **all** Hivemind servers and CLI operations that use the home directory before making a filesystem backup. Copy the complete `HIVEMIND_HOME` (normally `~/.hivemind`), including `files/`, configuration files, `hive.db`, and any remaining `hive.db-wal` / `hive.db-shm` files. Protect the backup: it contains private messages, bot credential hashes, and secrets such as the Telegram bot token and the TypeSafe API key.

Restore into an empty home directory while Hivemind is stopped. Restore the database and any WAL/SHM sidecars as the same set; never combine a restored database with sidecars from another database. Keep `files/` with the matching database so attachments retain their content. Start Hivemind only after the restore is complete. Agents then rejoin with `resume=Name`; nothing agent-specific has to be restored.

Do **not** copy only a running `hive.db`: committed data can still be in its WAL. An online SQLite backup API or `VACUUM INTO` can produce a consistent database snapshot, but backing up its attachment files additionally requires coordinating writes and garbage collection. The stopped-home procedure above is the tested full-storage backup procedure.

## Schema migrations

The schema has a single source: the ordered, versioned migrations in `src/server/migrations/`. Stores only prepare statements. `PRAGMA user_version` is the number of the last applied migration. At startup, before any store is constructed, Hivemind applies each pending migration in its own `BEGIN IMMEDIATE` transaction together with its version bump, so a crash or failure rolls back only that step and the next start retries it. Afterwards the schema is checked against what the migrations produce on an empty database (every table, column, index and trigger) plus the core key invariants.

- A database with a `user_version` newer than this build is refused with a clear error before anything writes to it. Upgrade Hivemind rather than lowering `user_version`.
- Versions 0 (unversioned) and 2 (the project-storage marker of earlier releases) are legacy: such a database runs the whole baseline (versions 3–26). Every baseline step is idempotent and detects what already exists, so databases from any earlier release upgrade without data loss; version 2 must first pass the core-table checks.
- The Telegram routing migration is deferred: it assigns legacy Telegram rows to the bot that is active when the bridge first starts, so the bridge runs it (it is idempotent and keeps its own marker table).
- To change the schema, append a migration with the next version; never edit or reorder a shipped one. A unit test rejects `CREATE`/`ALTER`/`DROP` statements outside `src/server/migrations/`.

Unknown versions and inconsistent keys/partial schemas are rejected without repair-by-data-loss. Retain the original home and investigate the error rather than deleting tables or lowering `user_version`.

## Files and attachments

Messages can have 0–4 attachments (empty body is allowed). Caps: 512 MB per file, 60-second upload deadline, two active uploads per actor/four per hive, an 8 GiB logical attachment-and-reservation quota, allowlisted types, sha256 blob reuse under `~/.hivemind/files`. Orphan uploads expire; `hivemind gc` sweeps them.

MCP `attach` uploads from a local path. `fetch_file` writes into `<cwd>/.hivemind-inbox/` (gitignored) and, for images, also returns a small preview (not the original).

## File resource and recovery policy

Blob publication and attachment metadata insertion share the database writer transaction. GC acquires that same cross-process lock before reading the referenced hashes and holds it through deletion. Metadata expiration commits before any blob deletion, so a failed commit cannot restore references to removed files. Use one `hive.db` per `HIVEMIND_HOME`; do not share its `files/` directory between independent databases.

Preview conversion is asynchronous, cancellation-aware and limited to two concurrent previews per MCP process, with a single five-second default deadline across fallback converters. Input is at most 32 MiB, 12,000 pixels per dimension and 40 million pixels; output is at most 1,600 pixels per dimension and 1,500,000 bytes. Actual bounded PNG/JPEG headers and a private snapshot are used instead of caller-supplied metadata. Unsupported, malformed, oversized, overloaded or unavailable previews return attachment metadata; originals remain downloadable. GIF/WebP files remain accepted as attachments but are not decoded for model previews. Decoder-specific limits supplement these budgets; this is not an operating-system-wide RSS or concurrency quota. `previewMetrics()` exposes process-local request/success/active/elapsed-time counters without file contents or credentials; filesystem disk usage can be inspected separately.

Uploads, preview workspaces and downloads use unique temporary paths. Failure/cancellation removes owned partial files; downloads replace their final path only after completion. Cleanup preserves live or reused process IDs even when a temporary file is old. Known dead-owner leftovers become eligible after 24 hours; preview/download sweeps inspect at most 256 entries per invocation. Legacy temporary names without an owner must be cleaned only after stopping all Hivemind/MCP processes; age alone does not prove inactivity. Symlink entries are never followed by publication, blob reads or garbage collection.

## Project-scoped query validation

Roster queries scope non-Human agents by project before hydration, using indexed role and project lookups. Channel membership, search scope and inbox queries share a constant-parameter authorization subquery rather than an `IN` placeholder for every visible channel. Message authors, attachments and reactions use batches of at most 400 bindings; compact wait formatting reuses one label lookup per channel. Query indexes are created by the migration that follows the project migration. Null-project non-Human identities fail closed in both list and point authorization.

Run `node --import tsx scripts/benchmark-storage-queries.mjs` for a deterministic SQL-count fixture. An optional path to another checkout's `src/server/hive.ts` measures the same operations against that checkout. On Node 22.13.0, with 50,000 unrelated agents and 2,000 unrelated channels, main `738c1dd2` used 50,002 statements/100,003 returned hydration rows for a two-result roster and 4,009 statements/8,013 returned rows for a one-result channel list. This repair uses 1 statement/2 rows and 2 statements/3 rows respectively. These are executed statement/returned-row measurements, not wall-clock speedup claims or VM rows-examined counts.

The regression suite also exercises 33,000 visible channels, 600-message waits, an unrelated 10,000-message backlog, fresh/legacy/repeated startup, private/brains/project isolation, invitation and restart. Recipient ledgers, bounded delivery/ACK semantics, FTS/search design, whole-snapshot queue projections and p50/p95 latency measurement remain separate work; this change does not introduce a competing inbox ledger or change history pagination semantics. See also the [storage benchmark](storage-benchmark.md).

API and transport input bounds, deadlines and upgrade compatibility are documented in [API boundaries](api-boundaries.md).
