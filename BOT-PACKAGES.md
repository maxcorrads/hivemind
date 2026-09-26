# Bot packages

Hivemind has one **Bot** concept in its domain model, API and UI. A bot can be
implemented in an external package, as GitLab is, without creating another kind of
service. Its installed definition describes capabilities, settings and executable;
its project identity has credentials and explicit capability grants. These are
parts of the same bot.
Provider code stays in its own repository and package. The canonical manifest,
CLI, capability model and deployment steps are documented in [BOTS.md](BOTS.md).

## Declarative settings

A bot manifest may point to a local settings schema. Supported types are string,
integer, boolean, and strings (one entry per line). This is a bounded declarative
schema, not arbitrary JSON Schema or executable UI code. Fields have a key, label,
type and optional description, default and required flag. Integers support
minimum/maximum; string fields support choices and minLength/maxLength.

Unknown keys, incompatible constraints and reserved keys are rejected.
Boolean fields use their default or false; saving submits that displayed value.
List entries retain whitespace, order, duplicates and blank entries; invalid entries
are rejected, not silently removed. Clearing the list sets an empty array.

Do not put secrets in settings. They belong in the provider credential store or a
private bot profile. Bot instructions and tool results must also exclude secrets.
See the external GitLab bot's settings.schema.json for a complete example.

## Configuration execution

Saving service settings executes the installed file directly, without a shell:

`EXECUTABLE configure --home PROFILE`

Stdin contains `{config, projectId}`. Config includes the exact local hiveUrl.
The executable must validate and atomically persist PROFILE/config.json, retain
the project binding, and return `{configured:true}`. Configuration must not read
providers, create bot identities, call a model or start monitoring. The core checks
the saved settings before recording success. An arbitrary executable's side effects
cannot be rolled back by Hivemind.

Compact config and persisted config are each bounded to 64 KiB; authors must account
for their own formatting before replacing a file. Runtime is limited to 15 seconds
and combined stdout/stderr to 64 KiB. Errors returned to clients never echo raw output.
Tool invocation has its separate 30-second contract in BOTS.md.

Updates are revision-fenced, serialized and bounded to eight running/queued updates
per process. Server and CLI updates share bot-configurations.lock; a retained crash lock
requires operator verification before removal. Profile bindings reject sharing a
canonical path between project bot configurations, including symlink aliases.

## Operations and trust

GitLab and other provider bots are installed separately. Register packages only from trusted local
paths using `hivemind bots add`. Registration reads metadata; it does not configure,
enable, connect or start a bot. Profile data is private runtime state, never source
code to commit. Removing a package/project does not erase its profile or stop a monitor.

Disabling a service or removing Tools prevents future brain invocations, not already
dispatched work. Publish and Receive are enforced by the bot API independently.
Stop monitors and revoke credentials explicitly when appropriate. Configuration and
tool calls use an allowlisted OS environment; this is not an OS sandbox. See the
[extensibility security contract](EXTENSIBILITY-SECURITY.md).
