# Worker templates

A worker template is a worker Human allows the brains of one project to launch: the agent CLI and how to run it, plus
what a brain needs to pick it. Templates are the first step of brain-launched, task-bound workers; see the
[roadmap](agent-management-roadmap.md) (Phase A1, #276). This page describes what exists today: templates can be
created, listed, edited, duplicated and deleted, but nothing launches from them yet.

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

`:project` is the project's slug or id. A stale revision answers `409`, a taken slug `409`, the 33rd template `429`.
Each committed change publishes a `worker-templates` realtime event with the `projectId`.
