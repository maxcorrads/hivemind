# Extensibility security contract

## Trust boundary

A bot is a project-bound observation publisher, not Human, a brain, or a worker.
Its bearer credential authorizes only the bot ingress API. Channel membership is
explicit, and a project-A bot cannot use that API to post into project B, fetch
files, enumerate identities, search history, manage plugins, or rotate credentials.
Origin metadata and quoted instructions never confer Human/agent authority.

An installed plugin is **trusted local software**, registered deliberately using
the CLI. It is not downloaded or installed through HTTP. Hivemind has no HTTP API
for choosing an arbitrary executable, shell command, or manifest path. The Human
configuration action runs the executable from the validated local package, with
its explicit project profile. Profile bindings reject canonical path aliases that
would share another project/plugin's profile; they are not OS access-control rules.

**This is not a sandbox.** A malicious program running as the same OS user can read
that user's files and call local APIs. Origin/Host checks and rejection of bot or
agent Authorization headers on Human routes are browser/credential-confusion
defenses, not authentication of arbitrary local processes. The Node HTTP transport
also requires a process-lifetime Human session before any Human route, including
Configure, bot creation, credential reads, rotation, and revocation. WebSocket
upgrades require that session and an exact trusted Origin before subscribing.
The web API uses the shared session client for every Human operation; none of
these routes has an unauthenticated exemption. See
[Local Human security](docs/local-human-security.md) for bootstrap, cookie lifetime,
Vite support, restart recovery, and the remaining local-process/XSS boundaries.
Keep the listener on loopback; do not expose it through an untrusted network proxy.
Do not run untrusted plugins, and never represent this model as hostile multi-tenant
execution isolation. Stronger isolation requires a separate OS/security boundary.

## Credentials, durable events, and recovery

Human creates a bot with no memberships and receives a random token once. Only its
hash is stored in SQLite. Rotation/revocation uses an expected revision and an
atomic transaction; old tokens reject subsequent authentication while bot identity,
channel invitations, attachments, message history, and event IDs remain intact.
A lost rotation response requires reloading state and a deliberate new rotation,
not an automatic destructive retry. Only a marked transport 401 proves the handler
never ran and permits one replay after a shared session refresh. Generic handler
errors, ambiguous network failures, and non-replayable streams do not permit
mutation replay. Human responses use `Cache-Control: no-store`.

Event deduplication is durable and scoped by bot, channel, root thread, and event ID.
An identical retry returns the original message without another notification;
changed content under the same ID returns 409. Message, dedup record, and attachment
binding commit together. A failed transaction always attempts rollback, including
on Node 22.13.0, where `DatabaseSync.isTransaction` does not exist. JSON ingress
reauthenticates after asynchronous body reading, immediately before the synchronous
commit path, so a token revoked during that read cannot publish afterward.

Revocation is not process termination. An upload authorized before revocation may
finish, but it does not itself publish an observation. A new message still requires
a current credential. Disable/unregister also does not stop external monitors or
revoke a bot. Deliberately stop those programs and revoke credentials as appropriate.

New database files and existing DB/WAL/SHM files are restricted to mode 0600 before
SQLite opens them; final-component symlinks are rejected. New data/upload directories
are mode 0700 and upload files are 0600. This does not retrofit every legacy blob's
permissions or protect against a malicious process with the same user privileges.
Never place credentials in event content, generic settings, source URLs, instructions,
or commits: those are not secret-storage channels.

Optional Jev adaptive routing uses a separate local credential file,
`adaptive-routing.json`, written atomically with mode 0600 under `HIVEMIND_HOME`.
The Human settings API returns only whether the key exists plus a short suffix hint,
never the full key. When the toggle is enabled, the outbound TypeSafe request contains
the new Human request text and current project name/slug; it does not include
repository files, Git diffs, Hivemind history or agent/bot credentials. Runtime
routing telemetry stores the request hash/byte length rather than duplicating the
request text, and its JSONL file is forced to mode 0600. A local process running as
the same OS user remains inside the existing local-process trust boundary.


## Admission and execution bounds

| Surface | Enforced bound |
| --- | --- |
| Bot event JSON | 64 KiB of actual streamed UTF-8 bytes |
| Bot creation/credential JSON | 4 KiB |
| Jev adaptive-routing settings JSON | 4 KiB; private local config is 0600 |
| Jev runtime classification | 2-second provider timeout; provider failure falls back to orchestration |
| Plugin HTTP settings envelope | 128 KiB; persisted config remains 64 KiB |
| JSON reading | 10-second deadline, abort cleanup, no parsing before byte validation |
| Bot admission | 60-request burst, 10 requests/second refill per identity |
| Concurrent bot requests | Four per bot, 32 per app; at most 1,024 admission entries |
| Plugin updates | At most eight running/queued updates per process |
| Plugin configure | 15 seconds; 64 KiB combined stdout/stderr |

Admission is in-memory protection, not a durable quota. Overload returns 429 with
`Retry-After: 1`. Retry with backoff and the same event ID after an uncertain send.
Deadlines and rejection release their readers, timers, listeners, and admission
slots. Blob uploads retain the existing 512 MiB per-file limit; they are not subject
to the smaller JSON limit. Restart resets rate buckets, not durable event dedup.

Configuration uses direct execution without a shell and a profile working directory.
Only an explicit basic OS environment allowlist is inherited; service credentials
and `NODE_OPTIONS` are not forwarded. Plugin-specific secrets belong in its separate
local credential store, not generic settings or inherited server variables. Ordinary
remaining subprocess-group members are killed at exit/deadline; a deliberately
detached daemon or malicious executable is outside this contract.

Plugin stdout/stderr and configuration error receipts are never copied to HTTP or
model-visible errors. Malformed JSON diagnostics are generic to avoid source-fragment
leaks. Unexpected HTTP failures log a fixed diagnostic without request bodies,
authorization headers, URLs, or error objects. This deliberately trades detail in
the UI for confidentiality; use the trusted plugin's local validation workflow.

## Regression coverage and integration

The integration preserves the behavior and tests from #36, #37, and #44, including
schema-valid list round trips, mounted credential recovery, real HTTP-to-stdio MCP
observation delivery, and attachment retrieval. Additional tests exercise bounded
streaming, forged authority, cross-project routes, duplicate bursts, stale/revoked
credentials during reads, restart, rollback without newer SQLite APIs, hostile
configuration output, environment inheritance, bounded queue recovery, private
storage, and cleanup using controlled clocks/deferred promises rather than sleeps.

Run `npm run check` and `npm run test:coverage` with Node 22.13.0 and 24. All TS/TSX
tests remain discoverable; the test runtime explicitly uses the web JSX configuration
while separate server/web typechecks remain intact. Coverage thresholds and release,
package, dependency, lint, and security checks must not be lowered for integration.
The macOS launch-script tests also require the real `zsh` executable.

Combined-session acceptance in `web/extensibility-session.test.ts` exercises the
actual Node listener and installed fixture executable: missing, forged, stale,
foreign-Origin, and bearer-confused Human requests leave identity hashes,
credential revisions, memberships, events, registry and profiles unchanged.
Recovery tests prove a single rotation/configure execution after pre-handler
rejection, no automatic retry after lost committed responses, cross-project
rejection, and durable event replay after restart. Fresh sockets isolate the
pre-handler-401 case from pooled-socket shutdown races; network ambiguity is tested
separately, not hidden by a production retry.

The Chrome acceptance test uses the actual Vite proxy and `web/api.ts`, normal
browser security, and browser-supplied cookies/Origin. It covers bot creation,
rotation/revocation, plugin execution, cross-origin rejection, concurrent restart
recovery and isolation from a second Hivemind instance. Mounted React fixtures
remain internal-router tests with a bootstrap stub; they are not mislabeled as
real-network or visual browser acceptance. CI requires its installed ChromeDriver;
local runs explicitly report a skip when a matching driver is unavailable.
