# Worker templates

A worker template is a worker Human allows the brains of one project to launch: the agent CLI and how to run it, plus
what a brain needs to pick it. Templates are the first step of brain-launched, task-bound workers; see the
[roadmap](agent-management-roadmap.md). Human edits templates; brains request task-bound workers through the durable
launcher queue. Hivemind Server.app executes approved launches with the template secrets.

## Editor

**Project settings → Worker templates…** lists the project's templates with Edit, Duplicate and Delete (after a
confirmation). The editor has the Launch sheet's fields (software, model and effort, CLI flags, environment variables
as `NAME=value` lines) plus the name, slug, "when to use it" description, seniority, focus, how many may run at once,
secret names and whether brains may use it. A command preview shows what the template will run, built by the same
code as the Launch sheet; Hivemind adds the prompt that joins the worker to its task at launch. Save is offered only
when the preview builds and the environment variables are valid; the server's reason is shown if it refuses.

## A template

| Field | Rule |
| --- | --- |
| `slug` | 1–32 lowercase letters, digits and `-`, starting with a letter or digit; unique in the project |
| `label` | 1–80 characters, shown to Human and brains |
| `description` | 1–500 characters: when a brain should use this worker |
| `software` | The agent command, as in the Launch sheet (`codex2`, `opencode-hm`, `claude`…): one command, no shell metacharacters |
| `model`, `effort` | As in the Launch sheet; empty for the CLI's default. `effort` is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `extraFlags` | CLI flags, at most 1,000 characters, no shell metacharacters |
| `environment` | Non-secret environment variables, with the [launch environment](terminal-broker.md#launch-environment) rules |
| `secretNames` | Up to 8 names of secret environment variables (for example `OPENCODE_API_KEY`); never the values |
| `seniority`, `focus` | The worker's seniority (`junior`, `mid`, `senior`) and an optional focus label (at most 80 characters) |
| `maxConcurrent` | How many workers of this template may run at once, 1–8 |
| `enabled` | Whether brains may use it |

A template is checked with the same launch builder the Launch sheet uses, so any template that saves can be launched.
Every edit bumps its `revision`; edits and deletions must name the revision they started from. A project has at most
32 templates. Deleting a project deletes its templates.

## Launching from a template

**Launch agent → From a template…** starts a worker for one task (roadmap Phase A1; brains get the same in Phase A3):
choose the project, an enabled template, a short **Task** name and the workspace path. The preview shows the command
with a stand-in for the ticket. **Start** (the apps) reserves the worker ([Reserved workers](identity-lifecycle.md#reserved-workers)),
named after the task, and starts it in its own tmux session with the template's environment variables and its id, so
Hivemind Server adds the template's secrets from its Keychain to the launch file. **Reserve and copy** reserves it and
copies the command for a terminal; secrets are then not passed. The launch prompt joins with `claim=<ticket>` and tells
the worker to create its own git worktree and branch when its task arrives. A template at its `maxConcurrent` limit
cannot be launched; a reserved worker whose launch fails gives up after 30 minutes.

## Secrets

The server stores only secret **names**. Their values are entered in the template editor, in Hivemind.app on the Mac or
in the iPhone/iPad app, once the template is saved: each declared name shows whether a value is kept, with a
write-only field to set or replace it and **Remove**. The value goes from the page to the app and on to Hivemind
Server.app's terminal broker (`secrets.set`, see [Template secrets](terminal-broker.md#template-secrets)), which keeps it
in the login Keychain as a generic password: service `<Hivemind Server bundle id>.template-secrets`, account
`<template id>/<NAME>`. Nothing ever reads a value back: the broker answers with names only, and a value will leave
the app only in a launch's private file ([Launch secrets](terminal-broker.md#launch-secrets)) when brains launch
workers (Phase A2). A browser has no bridge, so it says to use the apps. Deleting a template in the apps also deletes
its secrets from the Keychain. A validation error names the field and the reason, never a value.

## HTTP (Human only)

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/ui/projects/:project/worker-templates` | | `{templates}` sorted by slug |
| `POST /api/ui/projects/:project/worker-templates` | `{slug, spec}` | the template, `201` |
| `PUT /api/ui/worker-templates/:id` | `{expectedRevision, slug?, spec}` | the template |
| `DELETE /api/ui/worker-templates/:id?revision=N` | | `{ok: true}` |

`POST /api/ui/worker-templates/:id/reserve` with `{label?}` reserves a worker from the template and returns
`{agent, ticket}` (`201`); see [Reserved workers](identity-lifecycle.md#reserved-workers).

`:project` is the project's slug or id. A stale revision answers `409`, a taken slug `409`, the 33rd template `429`.
Each committed change publishes a `worker-templates` realtime event with the `projectId`.

## Brain requests and launch mode

A brain starts in **Approval** mode. Human changes it to **Auto** or back to **Approval** in the brain's roster menu;
`whoami` reports the saved mode. Changing mode affects subsequent requests, not requests already awaiting approval.

`worker_templates` returns enabled templates in the brain's project, with their per-template capacity.
`request_worker` takes a UUID `requestId`, a template slug or id, a task contract and an optional task `slug`. It atomically
reserves an identity, assigns the task and creates a launch request. Retrying the same id and payload returns the same
result; reusing it with another payload fails. Without a slug the name derives from the objective. The task-bound worker
creates its own worktree and branch before working. For an existing cancelled task, or one whose previous worker is no
longer available, pass `taskId` and `expectedRevision` together. Only its assigning brain can replace the worker.

Human reviews pending requests in For you in the Mac or iOS app, where the template can be changed before approval.
The native approval transport is required; a browser shows the request but cannot approve it. Capacity is checked again
at approval. Launch outcomes appear in the task history. See [Terminal broker](terminal-broker.md) for the signed queue,
crash recovery and notification limits.

`release_worker` closes and archives an owned task-bound worker after its task ends or is revised away. Its history
remains, with an archived label, while it disappears from the roster. Its template slot remains occupied until the
launcher acknowledges session cleanup; a failed kill requires an explicit retry. Fixed workers are unaffected.

Migration 35 adds the per-brain mode, archive timestamp and request retry fingerprint. Back up the entire state home
with every server stopped before Human upgrades; no migration is applied to production by preparing these PRs.
