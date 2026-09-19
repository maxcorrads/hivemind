# Identity lifecycle and migration

A running MCP process owns one identity. Repeated/concurrent joins reuse its active
token and do not reset a receipt session. Role, seniority, explicit project and
registered-worktree compatibility are checked. To deliberately replace an
identity, start a new MCP process with an explicit token or a fresh join; a name
in tool input cannot silently switch the current process. Raw credentials are
retained in the process and are not included in model-visible join results.

CLI commands require an explicit --token or HIVEMIND_TOKEN belonging to that
shell. There is no global last-join fallback. Keep the export printed by CLI join
private; do not copy it to a model conversation. Two terminals do not inherit
each other's latest join. Saved resume identities are private 0600 atomic files
under 0700 identities-v2/<server-origin-hash>/<project>/<validated-name>.json.
Server origins include the port; localhost and 127.0.0.1 are distinct. Name-only
lookup fails if ambiguous. An explicit project wins over worktree inference; a
registered different worktree is rejected when project is not explicit.

Old identities/NAME.json and last-join.json are never silently trusted/migrated.
For migration, use the old token explicitly in a trusted terminal, join with the
correct project and name, and a successful server response creates the scoped v2
file. Remove old credential copies manually after confirming the new file. Do
not paste old identity JSON in chat. Malformed or public-mode v2 files fail closed.

Lost credentials require Human to use Credentials in the local UI, reload the
current revision and explicitly rotate. Revocation disables new authentication;
rotation issues a replacement token shown only in that Human response. The
credential update and superseding inbox generation are atomic. Unacknowledged
mail is not consumed by recovery. Stale expected revisions conflict; a lost
rotation response requires Human to reload and decide whether to rotate again,
never a blind replay. Old external processes are not killed: requests already
committed and external side effects cannot be revoked retrospectively.

The trusted same-OS-user local boundary is unchanged: a malicious process with
access to this user's files/UI is not isolated by this credential convenience.
