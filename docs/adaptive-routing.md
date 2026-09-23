# Adaptive orchestration routing

Hivemind's optional TypeSafe Jev integration is configured from **⇄ Adaptive routing** in the Human UI. The Phase 2 implementation in #128/#129 extends Phase 1 (#120/#126) from a one-time `single | orchestrated` recommendation to continuously evaluated execution topology.

## Which messages are routed

Jev decides how a **brain** handles a Human request: work alone, or delegate. Workers never go through Jev.

- **Every top-level Human message addressed to a brain**, from the Human UI or Telegram, in any channel: DMs, group channels and rooms. The message waits for the classification before it is delivered.
- **Owning brain**, in order: the room coordinator, then the @mentioned brains (one execution and one classification each), then the only brain in the channel. When several brains share a channel and none is mentioned, Jev still classifies the request and records an **observation** in the Routing panel, but nothing is enforced. An explicit mode needs a named owner.
- **Human thread replies** are a `human_message` coordination event: they revalidate the execution of their thread (or the brain's active execution in that channel) before delivery, with the usual anti-flapping rules. A reply in the thread of a completed execution reopens it together with its thread; a reply where the brain has no execution starts a new one rooted at that thread.
- **Not routed**: messages in channels without a brain (for example a Human DM with a worker), messages between brains, and all worker activity: messages, task lifecycle events, room acknowledgements and presence changes.

The feature remains opt-in. Disabling Jev stops external classification and releases automatic routing enforcement. Explicit Human overrides remain authoritative. Hivemind does not launch external Codex/Claude/Cursor sessions: the Human starts agents, and routing uses the workers that actually joined the hive.

## Execution modes

| Mode | Worker budget | New delegated work |
| --- | --- | --- |
| Single | 0 | The brain works directly; new delegation is blocked. |
| Brain + 1 | 1 | One worker, normally through a structured task/DM. |
| Multi-DM | At least 2 | Independent worker task threads/DMs within the approved budget. |
| Room | At least 2 | New work uses a Human-authorized room contract. Existing DM tasks may finish in place. |

Transitions are not a ladder. Single can jump directly to Room, and Room can return directly to Single once the destination's confidence and safe-checkpoint requirements are met.

Jev selects the topology and total worker budget. It does not choose particular workers, decompose the request, create subtasks, or grant room authority. Those remain the brain's responsibility within existing Hivemind authorization rules.

## Settings and Human overrides

The settings panel exposes the Jev toggle, TypeSafe API key, initial strategy fallback, and orchestrated topology fallback. The default orchestrated fallback is **Brain + 1**. Fallback selection is constrained by available capacity.

The composer of any channel with a brain exposes:

- **Auto · Jev**: Jev chooses between all feasible modes.
- **Single**, **Brain + 1**, **Multi-DM**, **Room**: an explicit Human mode for this request.
- **Orchestrated Auto**: Human requires orchestration; Jev chooses the feasible orchestrated topology.

A manual choice can apply to this request, be locked to the current task/execution, or be locked to the conversation. A conversation lock survives the next Human request until explicitly removed. The composer resetting to Auto after sending does **not** release the one-request override on work already underway.

With Jev enabled, manual overrides do not suppress classification: recommendations continue for Human review, but cannot automatically replace the locked mode. With Jev disabled, manual choices do not make an external request.

## Parallel executions and attribution

An execution belongs to one brain in one channel. A brain can coordinate several Human requests at once, in different channels, each with its own topology and worker budget. In the same channel, a new request to the same brain replaces that brain's previous execution (other brains in the channel keep theirs). A Human request is never rejected because of routing state: if the previous execution still has delegated work (an open task, a held claim or an open free-form delegation), the new request starts its own execution (initial Jev classification, new directive and executionId) while the previous one keeps **draining** beside it. A draining execution keeps its workers, commitments, policy and executionId, is reached by executionId, task or delegation thread (a bare channel names only the current request), and completes by itself once its delegated work ends. An idle previous execution is replaced as before. When several brains own a request, their initial classifications (and the revalidations of a thread reply) run in parallel, so a Human send waits for the slowest brain rather than the sum; there is no total deadline on that wait.

Each directive names its brain and executionId and, outside DMs, is addressed only to that brain, so workers in a group channel are not woken by it. While a brain has at least one active execution, every **delegation** (send to a worker, attach, `assign_task`, `task_event` revise, `room_event` configure/staff) must declare `executionId`; otherwise it is rejected with 400 listing the active executions. An executionId of another brain is 403, an unknown or finished one is 404/409. Other brain coordination may pass `executionId` too; without it, it is attributed only from explicit structure (task link, request or delegation thread, request channel) and is otherwise not evaluated. Agent responses include `adaptiveRouting` only when exactly one execution is active, and always list `adaptiveExecutions`.

## Capacity is execution-scoped

A free worker is online with fresh presence, has no unfinished task or held claim, and is not committed to another execution. Capacity distinguishes free workers from workers already committed to this execution; the latter remain usable without being counted twice.

Structured task ownership is linked to the execution in the same transaction that creates/revises the task. A successful preflight is not a reservation: availability, destination, policy revision and worker budget are checked again inside task admission. Failed admission rolls back the task and its assignment message together.

Free-form DM assignments are also tracked as commitments. A commitment ends when its delegation thread is marked done, or when the worker reports the outcome in that thread with `eventType: 'decision'` (or an `acknowledgement` carrying attachments as evidence); a bare acknowledgement only confirms receipt, and there is no idle timeout. Until then an open delegated thread is not treated as a free worker merely because it lacks a structured task record. Commitments of a completed or deleted execution never keep a worker busy. Sender-declared `progress` and `decision` labels cannot bypass admission when a brain contacts a new worker. Known active assignment threads can continue during a drain; new assignments are still blocked. Completed delegation threads cannot be reopened or reused to evade Single.

The classifier is offered only feasible topology choices and bounded worker-count choices. A contradictory or out-of-range response is rejected, not silently rewritten into a different Jev plan. If availability changes during classification, Hivemind refreshes capacity and re-evaluates. Repeated races preserve the existing mode rather than oversubscribing workers.

When no worker is free but orchestration is needed, the brain can continue safe local work. Human sees **Orchestration needed · no workers available**. Capacity changes trigger further evaluation.

A new top-level request never takes ownership of outstanding delegated work from the preceding execution: that work stays attributed to the draining execution until it finishes.

## Coordination boundaries

Jev is evaluated on Human messages addressed to a brain, brain coordination messages, delegation attempts, the assigning brain's task reviews and thread changes, brain room operations, and capacity changes caused by brain actions. Worker messages, worker task/room events and worker presence never trigger an evaluation, so a pending drain completes at the next brain or Human event. Ordinary file reads, searches, uploads, receipt acknowledgements and heartbeats do not themselves require classification.

Delegation is evaluated **before** committing the new assignment, including when the current mode is Single. The assigning brain's reviews are evaluated **after** their mutation commits, so the classifier and safe-checkpoint check see the work that has just finished. A worker submitting a result is not itself evaluated.

The same mutation is not counted twice merely because both pre- and post-action hooks exist. Stable event identities distinguish independent evidence from a retry. Retrying a committed send or task event reuses the existing operation and does not add another confidence vote.

Agent mutation controllers serialize the classifier check and mutation boundary. Credentials are revalidated after asynchronous waits; a credential rotation cannot authorize a pending write through an old identity.

This is execution policy, not a replacement for task, claim, channel or room authorization. In particular, existing claim conflict/revision semantics remain owned by TaskStore. Free-form messages still depend on accurate event/thread semantics; Hivemind cannot infer arbitrary off-platform tool use or work performed outside its coordination APIs.

## Confidence and anti-flapping

The policy is versioned in `src/shared/adaptive-topology-policy.ts`.

- High confidence is **0.90**, inclusive.
- Values below **0.60** do not authorize a mode transition, even after repetition.
- High-confidence escalation can apply on the first independent event.
- Medium-confidence escalation requires two consecutive matching targets.
- De-escalation to a non-Single target requires two consecutive matching targets.
- Any transition to Single requires **two consecutive evaluations each at least 0.90**, or **three consecutive medium-confidence evaluations**, plus a safe checkpoint.
- A target change resets the confirmation streak. Worker-count changes participate in target identity.
- After an actual transition, two new coordination events must occur before another automatic transition. Initial selection does not consume this cooldown.

A medium-confidence evaluation followed by one high-confidence evaluation is not two high-confidence confirmations. These values are explicitly selected policy parameters, not empirically proven calibration of Jev on Hivemind workloads.

## Safe delayed de-escalation

Hivemind records a pending target while useful distributed work is still active. New delegation pauses; existing work may report results and finish. It is not cancelled just to reduce the mode.

Single requires no active delegated task/thread, worker still needed, open blocker/dependency or unreconciled held claim. The brain's acceptance of a result is distinct from the worker merely submitting it. The acceptance mutation can release a pending downgrade because revalidation observes the committed state.

A Room-to-Single downgrade remains a direct transition: no artificial intermediate Brain+1 or Multi-DM execution is required.

## Provider failure

During ongoing execution, timeout, network failure, malformed response or unstable capacity **preserves the current topology**. A failed call is not evidence for a downgrade or escalation. Human sees a warning that the current mode is not being revalidated; a subsequent successful evaluation clears provider-unavailability status.

The initial request has no previous mode, so it uses the configured feasible fallback when classification is unavailable or too uncertain. This initial fallback is separate from ongoing preserve-current behavior.

The HTTP adapter uses a bounded timeout, rejects redirects, and caps both the routing request and streamed response. Errors are represented by sanitized failure classes rather than provider response bodies or credentials. Owned-server shutdown cancels and drains routing activity before closing SQLite; callers injecting their own Hive own its runtime/database lifecycle.

## TypeSafe API and privacy

The adapter calls:

```text
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TypeSafe API key>
model: jev-latest
```

The Phase 2 contract is `adaptive-routing-v2`. It includes atomic sufficiency, complexity, parallelizability, coupling, specialization and coordination signals, plus feasible topology and worker-budget choices. The provider contract is documented at <https://docs.typesafe.ai/api>.

The structured snapshot includes the original request, current and pending mode, capacity and available worker metadata, counts of active work/blockers/dependencies, recent coordination-event metadata, the triggering coordination summary, Human override, and the previous decision. It does not send repository files, diffs, attachment contents, full conversation history, agent credentials, or the TypeSafe key as classifier state. Telegram's sender-display prefix is excluded from the routing request; the original stored Telegram message remains unchanged.

The key lives in `<HIVEMIND_HOME>/adaptive-routing.json`, written atomically with mode `0600`. The Human API returns only whether a key exists and a suffix hint, never the full saved key.

## Jev call history (Human-only)

Each project has a **Routing log** entry in the left sidebar, below Decisions (`#/routing-log/<project>`; the older `#/jev/<project>` link still works). It lists every request Hivemind sent to Jev (TypeSafe) and its answer, grouped by the Human request (execution) that caused it, newest activity first. Each call shows why it was made (your request, your thread reply, a brain message, a delegation attempt, a task review, a room change or a capacity change), Jev's answer in one line, and what Hivemind did with it: applied a new mode, confirmed the current one, kept it while waiting for confirmation, kept it because Jev was unavailable, recorded an observation only, or discarded the answer because routing state changed during the call.

Selecting a call shows:

1. **Sent to Jev**: the request text and the context sent with it (mode at the time, worker capacity, delegated work, locks, triggering message).
2. **Jev's answers**: every question with its answer, confidence and probability distribution.
3. **Decision and result**: recommendation, overall confidence (the lowest answer confidence), reason, what Hivemind applied, model, latency and tokens.
4. **Raw JSON**: the exact request body sent to TypeSafe and the parsed response.

The full payloads are stored only in the local SQLite database (`jev_calls`), are served only on the authenticated Human API (`GET /api/ui/projects/:project/jev-calls` and `/jev-calls/:id`), and never include the TypeSafe key or provider error bodies. Failed calls keep what was sent and a local failure class (for example `timeout` or `http_503`). History is bounded to the latest 1,000 calls per project and is removed with its channel or project. New calls appear live through the Human `jev-call` websocket event.

## Human-only evaluation history

Phase 2 audit records live in separate SQLite routing tables and are broadcast on the authenticated Human `adaptive-routing` websocket topic. They do not create ordinary chat messages, inbox items, mentions or agent notifications. The Routing panel shows retained evaluations, recommendations and observations, with one tab per brain when several brains have executions in the channel; a lock applies to the selected brain's execution. Applied transitions are exposed separately for the Human UI.

A single initial applied-policy directive accompanies the original Human request. It is operational instruction, not the evaluation history. Agent API responses expose only the compact applied policy: execution ID, current topology, worker budget, whether delegation is paused and whether Human has locked the mode. Confidence votes, model/usage metrics and recommendations are not returned as agent context.

The Human view currently returns the latest 100 retained events, with bounded storage of 500 events per channel. The current recommendation retains provider model, latency and input/output usage; unknown monetary cost is not invented.

HTTP snapshots and websocket updates merge using a monotonically increasing channel revision, not arrival order. Navigation and reconnect fence earlier requests; a delayed lock response cannot edit another execution. Lock writes from the UI include the execution ID and revision they were based on. The monitoring indicator distinguishes **active**, **waiting for the next check**, **disabled**, **unavailable**, and **completed** rather than showing a stale green status after Jev is switched off.

The brain or Human completes an execution by marking the original request thread done, after delegated work and claims have been reconciled. Human may also complete a request whose free-form delegations are still open: they are released and the routing audit records a warning; structured tasks and claims must still be finished or reconciled. Human closes every brain's execution rooted at that thread; a brain closes only its own. Conversation locks are kept per brain and channel; databases from earlier releases are migrated from channel-only keys on startup. Closing/reopening the execution and the thread is one transaction. Closed executions are not continuously reclassified; one-request/task overrides expire, while conversation locks remain available for the next request. Replacing a legacy request while Jev is disabled does not resurrect an old execution on re-enable (one with delegated work drains instead of being completed). Executions are keyed by execution ID with one current execution per brain and channel; databases from earlier releases are migrated on startup, keeping every existing execution current. The Routing panel shows each brain's current execution; a draining one appears through its audit events (superseded while draining, then drained) and its row is dropped at that brain's next request once finished. Channel/project deletion removes routing state, locks and audit in the same database transaction. Routing-vote deduplication is bounded to 5,000 entries per live execution; committed operations retain their own independent retry ledgers.


## Tests and validation

The tests use fake TypeSafe responses with real local SQLite, HTTP and UI boundaries. They do not spend a live provider key or establish production model quality.

Focused coverage includes authenticated real websocket delivery, stale UI snapshots and reconnect, lifecycle/lock races, malformed and oversized provider replies, destination-aware hysteresis, direct jumps, the inclusive 0.90 threshold, retry identity, Human override precedence, provider failure/recovery, audit/context isolation, actual task admission/link atomicity, free-form commitments, capacity ownership and delayed Single transitions after accepted results.

Run the repository's standard lint, typecheck, unit, integration, browser and coverage jobs before merge. A green fixture suite establishes the implementation contract, not calibrated routing quality on real workloads.
