# UI realtime integration boundaries

This is a deliberately narrow port of PR #63 from `main` at
`cc079096f98738393ddd604fc383812c70071e84`, related to #21, #25 and #65.
It does **not** replace all of #63 or close #21. Keep #63 open until the
remaining acceptance cases below are implemented and verified.

## Included

- Preserve the reviewed `Hive.touch` policy: unchanged online heartbeats write
  at most once per 15 seconds per agent; online/offline changes write and emit
  immediately; missing/deleted agents are no-ops. Liveness remains separate
  from visible presence broadcasts.
- A server-instance ID and increasing event sequence order the live stream.
  `hello` reports the current sequence. These are **not** durable replay cursors
  and **not** HTTP snapshot revisions.
- At most 256 distinct project/agent updates wait in the client buffer, with
  one 16 ms flush timer. Repeated same-agent updates retain the last arrival.
  Reaching the capacity flushes rather than silently dropping other agents.
  State transitions and non-presence events flush prior work. Message,
  reaction and queued events are never coalesced. Project/hello boundaries
  cancel pre-boundary pending presence.
- Old socket callbacks, duplicate/out-of-order envelopes and foreign-instance
  events cannot mutate a newer connection. Reconnect/disposal cancels pending
  work and detaches handlers. Legacy unversioned servers remain supported.
- No changes to package metadata, lockfile, license, CI, release workflows,
  read-state semantics, authentication, or `App.tsx` rendering.

## Tests and measurements

`src/shared/realtime-client.test.ts` runs 25 deterministic cases with fake
schedulers/transports and no sleeps. `src/server/presence.test.ts` adds four
real SQLite/WebSocket cases. Fixtures close sockets, servers, DB handles and
remove temporary directories.

On Node 22.13.0 these 29 focused tests pass. In the fixed-clock burst fixture,
10,000 redundant touches produce zero additional writes/broadcasts; the
15,000 ms boundary produces one write and no broadcast. The client fixture
retains one pending update and one scheduled callback for 10,000 same-agent
updates. These are operation counts, **not** real-browser performance claims.
The client module has 100% line/function coverage and 97.20% branch coverage
in that focused run. Full CI coverage thresholds remain unchanged.

Local lint, server/web typechecks and production build pass. The local full
`npm run check` reaches one pre-existing platform failure in the roster-paste
fixture because this Linux environment has no `zsh`; this is not a full-suite
pass and is not suppressed. GitHub's macOS Node 22.13.0/24 checks remain the
required acceptance gates for the actual PR head.

## Deliberately not ported from the old branch

1. **Unconditional newest-500 eviction.** It discards older messages being read,
   selections and thread-root metadata. A follow-up must preserve an anchor,
   older-history reachability, keyboard/read order and copy/search behavior.
2. **Heartbeat/overload disconnect policy.** Closing a slow socket can miss
   messages/reactions. Do not introduce this policy until #52/#11 (owned by the
   #25 browser workstream) reconciles the active channel/thread after reconnect,
   including events newer than a pending HTTP snapshot. A socket generation
   guard alone does not fix that race.

No claim is made that server send buffers, retained DOM nodes, total traffic,
roster cardinality or process memory are bounded by this slice. No new server
backpressure disconnects are introduced.

## Browser handoff to #25

Use mounted tests for project deletion during a presence burst; online/offline
oscillation; reconnect to an authoritative roster; late callbacks from an old
connection; new messages/reactions before an HTTP snapshot resolves; and
history/selection/root preservation during live traffic. Coordinate read-state
coverage with #51: channel open must retain unopened-thread mentions, reading
a thread must persist, a later reply must be unread, and navigation must never
acknowledge an obsolete response. Browser execution is not claimed here.
