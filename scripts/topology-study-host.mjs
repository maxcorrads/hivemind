// LEGACY (#211): live host for the #136 topology-study runner.
//
// The paired study compared Auto against four *fixed* topologies that the server enforced through a Human lock
// (routing/lockScope on the Human send, applied worker budgets, delegation 409s). Since #211 Jev is advisory-only:
// the server enforces no topology, accepts no routing/lock fields and posts no directive, so a fixed baseline can no
// longer be produced. `createHivemindHost` therefore refuses to start instead of running trials whose conditions would
// silently not hold. The runner's credential-free actions (prepare, validate, dry-run, reconcile, export) and the
// #132 validator keep working on existing study directories. To execute the study, use a release before #211.

export const JEV_KEY_ENV = 'HIVEMIND_STUDY_TYPESAFE_KEY';

export const LEGACY_HOST_MESSAGE = 'The live topology-study host needs server-enforced topologies, which were removed in #211 ' +
  '(Jev is advisory-only). Run the paired study from a Hivemind release before #211; prepare, validate, dry-run, reconcile ' +
  'and export still work here.';

/** Always refuses (#211): see the module comment. */
export function createHivemindHost() {
  throw new Error(LEGACY_HOST_MESSAGE);
}

/** OpenCode `step_finish.part.tokens.total` is cumulative per seat: keep the latest valid value, readable mid-run for budgets. */
export function liveUsage() {
  let pending = '', latest = null;
  const consume = line => {
    if (!line.trim().startsWith('{')) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const value = event?.type === 'step_finish' ? event?.part?.tokens?.total : undefined;
    if (Number.isSafeInteger(value) && value >= 0) latest = value;
  };
  return {
    push(chunk) { pending += chunk.toString('utf8'); const lines = pending.split(/\r?\n/); pending = lines.pop() ?? ''; lines.forEach(consume); },
    finish() { if (pending) consume(pending); pending = ''; return latest; },
    latest: () => latest,
  };
}
