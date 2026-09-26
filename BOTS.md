# Bots with composable capabilities

A **bot** is a project-scoped service identity. It is not a worker and does not take agent tasks. Capabilities are independent, not intelligence levels:

| Capability | Access |
| --- | --- |
| Publish | Post idempotent observations and upload their attachments. Channel invitations are still required. |
| Receive | Poll messages in explicitly selected, invited project channels. No DMs, inbox ACKs, Human read receipts or implicit subscriptions. |
| Tools | Offer typed, service-specific functions to brains in the same project. Requires an enabled/configured bot definition and active credentials. |

Bot messages and tool results are context, never task authority. Granting a capability does not authorize a particular review, external write or command. Native client permissions remain in force.

## UI

Open **Bots** from the roster's `+` button, a bot's **Manage bot** menu, or project settings.

- **Add bot → registered service**: install a trusted external bot and register its manifest with `hivemind bots add /absolute/package/hivemind-bot.json --home /absolute/hive`, then refresh Bots. For GitLab, configure the host and local reader, enable the service, then create and connect its identity. Credentials go directly to its private profile. No polling starts during setup.
- **Add bot → Custom bot**: create a publishing identity and copy its one-time token into your service. Open its settings to enable Receive and choose channels explicitly.
- **Manage bot**: edit access, inspect the tool catalog, change service settings, or explicitly check/start/stop its monitor. A configured service is not proof of a running process. Status is checked on demand; stop requests must be verified with another status check.
- **Advanced**: rotate/revoke credentials or reconnect a bot definition. Reconnect replaces the bot token; stop the monitor first. Other clients using the previous token lose authentication. An uncertain connection result preserves the identity: inspect/reconnect it instead of creating another bot.

Settings, access and credential updates are revision-fenced. Changing grants blocks future requests, not work already dispatched. Disabling a service hides tools and prevents starts; it does not stop a running monitor. Stop is always an explicit action.

If `bot-definitions.json` or `project-bots.json` cannot be read, the Bots panel
shows a catalog warning but still lists existing identities. Their saved service
bindings are retained. Human can remove capabilities/subscriptions and rotate or
revoke credentials; custom bots remain manageable independently of the catalog.
Registered-service configuration, new grants and monitor controls still require
a valid catalog. Repair the local file and explicitly refresh to restore those
controls. Refresh does not re-grant removed access, repair files or start/stop
processes. Revoking credentials does not terminate an external process.

Monitor controls and reconnect send the access revision displayed by the page as
`expectedAccessRevision`. A changed binding/grant is rejected before dispatch (and
before credential rotation for reconnect); refresh and confirm the current target.
Reconnect additionally sends the credential's `expectedRevision`. Neither failure
automatically retries the operation against a different revision.

## External bots, one domain model

Hivemind supplies the generic capability protocol, tool executor and Bots UI.
GitLab's implementation, provider readers, monitor and tests stay in the separate
GitLab bot repository/package. Hivemind neither builds nor ships that code
and has no implicit provider bots. Install/update the bot independently and
register its manifest explicitly. Listing the catalog never runs package code.
Authentication stays in the native `glab` client. Tokens, provider databases and
runtime files are not shipped in either repository/package.

Like the core launcher, the GitLab launcher prefers source in a development
checkout; `HIVEMIND_FROM_DIST=1` explicitly selects an existing compiled build.
Installed packages use compiled JavaScript without a TypeScript loader.

GitLab implements **Publish + Tools**, not Receive. Its tools include `status`, `start`, `stop`, `follow`, `unfollow`, `watch`, `stop_watch` and `resume_watch`. Follow/watch configure sources while the monitor is stopped; `start` is explicit. The existing polling, deduplication and source archive/resume logic is reused. These tools do not run reviews or publish comments on GitLab.

Start waits for a readiness handshake from its own new process, after initialization
and lock acquisition, with a 20-second limit inside the tool's 30-second budget.
Slow startup is not mistaken for failure after three seconds. Failed or cancelled
starts terminate only their own child; a child abandoned before acknowledgement
cannot later become a daemon. Startup is serialized with profile changes and other
starts, and a Stop received during bootstrap is not overwritten by the new process.
No automatic restart or retry is performed.

Stop/unfollow also reconcile source-link status with Hivemind when the monitor is
already offline; a running daemon reports on exit. Reconciliation does not read
GitLab. Failed acknowledgements remain visible in local lifecycle diagnostics.

`stop_watch` reconciles its discovery source link even without a running monitor.
If a monitor is running, disabled discovery still checks Hivemind lifecycle state
at the existing bounded interval, including archive/resume acknowledgements. It
does not read GitLab, create MR channels or enable discovery again. Existing MR
subscriptions stay independent. Watch and discovery-subscription enablement are
saved atomically before any acknowledgement request.

GitLab status defaults to a compact summary and section counts. Pass `section`,
`offset` and `limit` for details; follow `nextOffset` until null. Long diagnostic
fields are marked as previews in `truncatedFields`. This keeps large retained
histories below the tool-output bound. The operator CLI retains its full local dump.

## Brain interface

Use the Hivemind MCP tools:

1. `bot_tools` discovers available bots and their parameter schemas.
2. `call_bot_tool` takes `{botId, tool, arguments}`. Workers and other projects cannot call these tools.

Only declared tools execute, with schema-validated arguments. `connect` is reserved
for Human provisioning and cannot be advertised as a brain tool. Callers cannot
choose an executable, shell command, profile, project, bot identity, credential or
environment. Each call uses the registered trusted local executable's
`invoke --home PROFILE` protocol, JSON on stdin and JSON on stdout. Output is bounded
to 64 KiB; the 30-second execution budget includes time spent queued. An expired
queued call is rejected before dispatch, never run later after a caller timeout.
Failures never automatically retry mutations; check status before retrying uncertain
outcomes. A long-running monitor must detach itself deliberately; ordinary child
processes are terminated with the invocation. A detached child retaining inherited
pipes cannot hold the request or configuration lock beyond its deadline.

## Bot package contract

A trusted local package has a `hivemind-bot.json` manifest containing `version: 1`, `kind: "bot"`, `id`, `name`, `capabilities`, `tools`, `command`, `instructions` and optional `settings`. Tool declarations contain `name`, `description`, `effect` (`read` or `configure`) and a `parameters` settings schema (`version: 1`, `fields`). Paths must resolve inside the package; the command must be executable. No package code runs when merely listing the catalog.

Supported executable operations:

- `configure --home PROFILE`: stdin `{config, projectId}`; persist settings locally and return `{configured:true}`. Must not start monitors or contact providers.
- `invoke --home PROFILE`: stdin `{tool, arguments, projectId, botId, botName}`; return a bounded JSON result, without secrets. `connect` additionally receives a private `token` and returns `{connected:true}`. It is Human-only provisioning, not an advertised brain tool.
- `status`, `start`, `stop` are conventional declared tools used by the UI. Status must inspect local state, not poll providers. Stop can report a request in progress rather than falsely claiming the process exited.

The package is trusted local code, not a sandbox. Capability checks constrain Hivemind's APIs; they cannot sandbox an executable's operating-system access.

```sh
hivemind bots add /absolute/package/hivemind-bot.json --home /absolute/hive
hivemind bots list --home /absolute/hive
hivemind bots bind DEFINITION_ID --project SLUG --config-home /private/profile --home /absolute/hive
```

The external catalog is `bot-definitions.json`; project profiles are bound in
`project-bots.json`. Every bot definition, including GitLab, resolves to its explicitly
registered external manifest path. There are no reserved built-in provider IDs.
Unregistering a bot definition does not stop its monitor, revoke credentials or erase
profiles. Register the new manifest path explicitly if an installation moves.
Private profile paths and configuration remain local to Human; brain tool discovery
returns only bot IDs/names and tool schemas.

## Receive protocol

Authenticate with the bot's Bearer token and request:

`GET /api/bot/channels/CHANNEL_ID/messages?afterSeq=0&limit=50`

The response contains `messages`, `nextAfterSeq`, `hasMore`, and `authority: "context-only"`. Persist `nextAfterSeq` only after processing a page. Limit is 1–100. Every request rechecks the capability, explicit subscription, current membership and project. Delivery is a polling feed, not exactly-once consumption; the bot must deduplicate any downstream effects. Attachment metadata is included, but this interface does not add a bot attachment-download API.

When Human saves Receive access, accepted channel names are resolved within the
bot's project and stored as canonical IDs. Repeated aliases for the same channel
are rejected without changing the access revision.

## API and deployment

The settings endpoint is
`/api/ui/projects/SLUG/bots/catalog` (`configurations` for the list and
`configuration` for a save); bot identity/access/lifecycle live under
`/api/ui/projects/PROJECT_ID/bots`. Bot access and project bindings use
`definitionId`. Launch context exposes `botDefinitions`, `botInstructions` and
optional `botError`; launch inputs use `botProject` and `botInstructions`.
External launchers consuming these fields must be updated before rollout.

The bot-capabilities database migration preserves existing bot identities, credentials,
event deduplication and channel memberships. Existing bots receive only Publish;
Receive and Tools require explicit Human grants.

Before a live rollout: stop affected monitors, back up the hive and private profiles,
upgrade the core and external bot separately, verify the external bot supports its
profile's current schema, register the bot's manifest, bind each configured profile
using its current bot identity, configure
access, verify local status, then start only the intended monitors. Do not reconnect
a profile to another bot identity. Restoring an older core requires restoring its
matching database backup. Keep the previous bot version as rollback material
until migration is verified.
