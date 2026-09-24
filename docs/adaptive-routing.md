# Jev advice (advisory routing)

Hivemind's optional TypeSafe Jev integration is configured from **Settings → Adaptive routing** in the Human UI. Since #211 Jev is **advisory-only**: it suggests to a brain how to organize a Human request (work alone, one worker, several workers in DMs, or a room) and how many workers to use. Hivemind never applies, enforces or locks that suggestion. The brain decides, and **Human instructions always take precedence over Jev's advice**.

Earlier releases (#128/#129, #207, #209) enforced the suggested topology: they applied a mode and a worker budget, rejected delegations that did not fit it with HTTP 409, posted a `[Hivemind adaptive topology · …]` directive, required an `executionId` on delegation, and offered Human locks. All of that was removed in #211; see [What changed in #211](#what-changed-in-211).

## When Jev is called

Workers never trigger Jev. Jev is called **synchronously** (the call waits for Jev, bounded by the provider timeout of 2 seconds):

- **Every Human message addressed to a brain**, from the Human UI or Telegram, in any channel: DMs, group channels and rooms. Jev is asked before the message is posted. The owning brain is, in order: the room coordinator, then the @mentioned brains (one call each, in parallel), then the only brain in the channel. When several brains share a channel and none is mentioned, Jev still classifies the request and records an **observation** for the Human; no brain receives advice. A Human reply in the thread of a request continues that request (and reopens it if its thread was marked done).
- **Every brain action**: `send`, `attach`, `assign_task`, `task_event`, `room_event`, `set_thread_status`, and each `wait` that delivers mail. The action runs first and is never blocked or reshaped; then Hivemind asks Jev and returns the advice in the response.

No call is made when Jev is disabled, when the brain serves no open Human request (for example before any Human message, or after the request thread was marked done), for a retried request (same `requestId`: the latest advice is returned without a new call), or for a `wait` that returns without mail.

## The advice a brain receives

Each brain action response and each `wait` result that delivered mail carries `jevAdvice`:

```json
{
  "jevAdvice": {
    "plan": "brain_multi_dm_2",
    "topology": "brain_multi_dm",
    "workers": 2,
    "confidence": 0.72,
    "state": "ok",
    "reason": "parallel_workstreams",
    "at": 1790000000000,
    "note": "Advisory only — you decide; Human instructions take precedence."
  }
}
```

- `plan` is a joint plan id of [contract v3](#question-design-contract-v3): `single`, `brain_one_worker`, `brain_multi_dm_<n>`, `brain_multi_room_<n>`, or `capacity_blocked` (workers would help but none is usable).
- `state` says how far the advice can be relied on:

| State | When | `plan` / `topology` / `workers` | `reason` |
| --- | --- | --- | --- |
| `ok` | A valid, coherent answer at or above 60% confidence | set | why Jev chose the plan, e.g. `parallel_workstreams` |
| `uncertain` | A valid answer below 60% | set | as above |
| `incoherent` | A valid answer whose parts contradict each other (a zero-worker plan while saying delegation materially helps) | set | `incoherent_plan_vs_sufficiency` |
| `rejected` | A response arrived but could not be used (malformed, or a plan that was not offered) | `null` | the failure class, e.g. `plan_not_offered` |
| `unavailable` | No response: timeout, network or HTTP error, cancelled at shutdown | `null` | the failure class, e.g. `timeout`, `http_503` |

- `jevAdvice` is `null` when Jev is off or the brain serves no open request; it is absent from worker responses.
- A provider failure never fails the action: it only yields `unavailable` advice.

The standing orders tell brains that the advice is advisory, that they decide from the task, that Human instructions always override it, and to treat any state other than `ok` as no advice.

## Requests (executions)

Each Human request handled by a brain is an **execution** (`execution-<uuid>`), one per brain and channel: a new top-level Human request to the same brain in the same channel replaces the previous one. Executions only group Jev calls for the Routing log and the evidence export, and keep the latest advice. A brain action is attributed to the brain's open request rooted at the action's thread, else its open request in the action's channel, else its most recently updated open request in the project. Marking the request's thread done closes the execution (no more calls for it); a Human reply in that thread reopens it.

`executionId` is no longer in any MCP or HTTP schema (#218). The server still **drops it unvalidated** from agent `send`/`attach`, `assign_task`, `task_event` and `room_event` payloads, and `hivemind send --execution-id` is ignored, so older clients keep working.

## Human UI

- **Advice strip** above the composer of a channel with a brain: `Jev suggests: Multi-DM · 2 workers (72%)`, or the state (`Jev uncertain (41%) · Brain + 1`, `Jev unavailable (timeout)`), with *Advisory only · the brain decides*. It opens the Routing panel. The composer has no mode or lock selector, and the Human send API rejects the removed `routing` and `lockScope` fields.
- **Routing panel**: the latest advice of each brain with a request in the channel (one tab per brain), evidence-capture state, and the Human-only audit of every piece of advice (`Brain delegated · Jev suggested Multi-DM · 2 workers (72%)`). There are no locks.
- **Settings**: enable Jev, the TypeSafe API key, the model identifier and the connection test. The former fallback settings are gone (they chose the enforced mode when Jev was uncertain); older configuration files that still contain them keep working and drop them on the next save.

## Routing log (Human-only)

Each project has a **Routing log** entry in the left sidebar, below Decisions (`#/routing-log/<project>`; the older `#/jev/<project>` link still works). It lists every request Hivemind sent to Jev (TypeSafe) and its answer, grouped by the Human request (execution) that caused it, newest activity first. Each call shows why it was made (your request, your thread reply, a brain message, a delegation, a task update, a room change, a thread status, mail delivered by `wait`), Jev's answer in one line, and what happened: *Advice returned to the brain · not enforced*, *Uncertain advice returned to the brain*, *Brain told Jev had no advice*, or *Recorded only · no single owning brain*. Calls recorded before #211 keep the enforced outcome they had (*Before #211: applied Brain + 1*).

Selecting a call shows:

1. **Sent to Jev**: the request text and the context sent with it (worker capacity, the brain's open structured work, triggering action; calls recorded before #211 also show the mode and locks of that time).
2. **Jev's answers**: every question with its answer, confidence and probability distribution.
3. **Advice**: the suggested plan, overall confidence (the lowest answer confidence), reason, what happened, requested and resolved model, latency and tokens.
4. **Raw JSON**: the exact request body sent to TypeSafe and the parsed response.

The full payloads are stored only in the local SQLite database (`jev_calls`), are served only on the authenticated Human API (`GET /api/ui/projects/:project/jev-calls` and `/jev-calls/:id`), and never include the TypeSafe key or provider error bodies. A rejected answer is labelled **Answer rejected** (never "Jev unavailable") and still shows Jev's answers, the resolved model and the tokens it used. History is bounded to the latest 1,000 calls per project and is removed with its channel or project. New calls appear live through the Human `jev-call` websocket event; advice updates through the Human `adaptive-routing` event. Neither creates chat messages, inbox items, mentions or agent notifications.

## Worker capacity

Jev sees capacity from the brain's point of view: a live worker is *free*, *working for this brain* (it holds unfinished structured work this brain assigned) or *busy elsewhere* (work from another brain). Free-form DM delegation is not tracked. Capacity is context for the advice, never a limit.

## TypeSafe API and privacy

The adapter calls:

```text
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TypeSafe API key>
model: <requested Jev model; default jev-latest>
```

The snapshot sent with each call includes the original request, the project slug and name, worker capacity and available worker metadata, counts of the brain's active work/blockers/dependencies, the last few brain actions (kind, event type, short summary), the triggering action with a summary of at most 400 characters, and the previous decision. It does not send repository files, diffs, attachment contents, full conversation history, agent credentials or the TypeSafe key. Telegram's sender-display prefix is excluded from the request; the stored Telegram message is unchanged.

The key lives in `<HIVEMIND_HOME>/adaptive-routing.json`, written atomically with mode `0600`. The Human API returns only whether a key exists and a suffix hint, never the full saved key. The HTTP adapter uses a bounded timeout, rejects redirects, and caps both the request and the streamed response. Errors are represented by sanitized failure classes, never provider response bodies or credentials. Shutdown cancels in-flight calls (the action still answers, with `unavailable` advice) before closing SQLite.

### Jev model: alias or pinned identifier

By default Hivemind requests the alias `jev-latest`, which TypeSafe may resolve to a different model over time. For reproducible evaluation, Human can pin an exact identifier in **Adaptive routing · Jev → Advanced options → Jev model identifier** (or `PUT /api/ui/adaptive-routing` with `{"model": "<id>"}`; `null` or an empty string returns to the alias). The identifier is bounded: 1–64 letters, digits, dots, underscores or hyphens, starting and ending with a letter or digit. It can never be a URL, host or path, and the TypeSafe endpoint is fixed regardless of it.

- Configuration files saved before this setting have no `model` field and keep using the alias. Reading them never enables Jev or contacts TypeSafe.
- Hivemind does not list models or prices and does not verify that an identifier exists or is immutable. An unavailable identifier makes the call fail (`http_<status>`), and the brain gets `unavailable` advice. Hivemind never retries with a different model.
- Each call records the **requested** model and the **resolved** model the provider reports, separately. The alias resolving to a concrete version is shown as information (`jev-latest → jev-1.13.0`); only a pinned identifier that resolves to something else is flagged.
- Changing the model affects later calls and revokes pending connection-test revisions. A call already in flight still returns its advice.

### Question design (contract v3)

The contract is `adaptive-routing-v3` (#207). Every call asks the atomic signal questions (single-agent sufficiency, complexity, parallelizability, coupling, specialization and coordination) plus **one joint `plan` choice**, so a topology/worker-count contradiction cannot be expressed. The provider contract is documented at <https://docs.typesafe.ai/api>.

| Option id | Plan | Offered when |
| --- | --- | --- |
| `single` | Single · 0 workers | always |
| `brain_one_worker` | Brain + 1 · 1 worker | `usable ≥ 1` |
| `brain_multi_dm_<n>` | Multi-DM · n workers | `2 ≤ n ≤ min(usable, 8)` |
| `brain_multi_room_<n>` | Multi-Room · n workers | `2 ≤ n ≤ min(usable, 8)` |
| `capacity_blocked` | Workers would help, none usable | `usable = 0` |

`usable` counts free workers plus those already working for this brain (`already_working_for_this_brain` in the question; they are not counted twice). Every option is sent and billed on every call, so the worker count is capped at `MAX_PLAN_WORKERS = 8` (at most 17 options). Overall confidence is the lowest confidence among the plan and signal answers. A `single` plan together with "insufficient" while workers are usable is **incoherent** (#209): it is kept as a valid call with Jev's reported confidence, flagged `incoherent: "plan_vs_sufficiency"`, and delivered as `incoherent` advice. The reverse ("sufficient" with a delegating plan) is coherent.

### Rejection reasons

A call that does not produce a usable answer records one specific failure class, which becomes the advice's `reason`. When the response arrived and was read, its resolved model and token usage are recorded even though the answer was rejected.

| Code | Meaning |
| --- | --- |
| `plan_not_offered` | Jev chose a plan that was not among the offered options |
| `plan_contradicts_sufficiency` | Before #209 only; such answers are now incoherent advice |
| `malformed_answer:<question>` | An answer is missing or has the wrong type, confidence, choice or score |
| `probabilities_invalid:<question>` | An answer's probability distribution is missing, has the wrong keys, does not sum to 1, or its choice is not the most likely option |
| `model_missing` / `missing_usage` | The response does not name the resolved model / does not report token usage |
| `malformed_response` | The body is empty, not JSON, or not a JSON object |
| `response_too_large` / `request_too_large` | The response or the request exceeds its size bound |
| `http_<status>` | TypeSafe answered with an HTTP error (for example `http_503`) |
| `timeout` / `cancelled` / `network` | No answer in time / cancelled at shutdown / TypeSafe could not be reached |
| `invalid_model_setting` / `invalid_timeout` / `invalid_snapshot` / `internal_error` | Local problems; nothing (or nothing usable) was sent |

## Storage

Migration 27 (`jev_advisory`, `src/server/migrations/jev-advisory.ts`) upgrades existing databases on the first start:

- drops `adaptive_topology_locks` (Human locks), `adaptive_topology_tasks` and `adaptive_topology_messages` (task and free-form delegation links used for admission and worker budgets) and `adaptive_topology_evaluated` (the anti-flapping vote ledger);
- deletes draining (non-current) executions, rebuilds `adaptive_topology_executions` with one row per (channel, brain) and strips the enforcement fields (applied mode, budget, pending target, lock, confirmations, warning) from their snapshots, keeping the latest decision;
- clears `adaptive_topology_events`, whose transitions, locks and warnings described enforcement (the full history remains in `jev_calls`);
- keeps `jev_calls` and the evidence tables (`adaptive_evidence_runs`, `adaptive_evidence_attempts`) unchanged. New evidence is recorded with policy version `topology-advisory-v1`, so it is never pooled with evidence of the enforced `topology-policy-v2.1`.

## What changed in #211

Removed: applied topologies and worker budgets, delegation admission (409 responses, permits, per-brain coordination lanes), room/DM restrictions, pending de-escalation and draining executions, the anti-flapping policy (confirmation streaks, cooldown), Human locks and their API (`PUT /api/ui/channels/:id/adaptive-routing/lock`), the composer mode selector and the Human send fields `routing` and `lockScope`, the `[Hivemind adaptive topology · …]` directive message, the mandatory `executionId`, the `adaptiveRouting`/`adaptiveExecutions` fields of agent responses, and the fallback settings. The live host of the paired topology study ([topology-study-runner.md](topology-study-runner.md)) is legacy: it needed fixed, enforced baselines.

Kept: Jev calls on Human requests and brain actions, the contract v3 question design, the precise answer states of #209/#210, the Routing log, evidence and collector health, the model pin and the connection test.

## Tests and validation

The tests use fake TypeSafe responses with real local SQLite, HTTP and UI boundaries; they never call the real provider. `src/server/jev-advisory.test.ts` covers: a delegation that contradicts Jev's advice succeeds; every brain action returns `jevAdvice` after exactly one Jev call while workers trigger none; a provider failure lets the action succeed with `unavailable` advice; the Human send has no routing or lock fields; shutdown and project deletion. `src/server/migrations/runner.test.ts` covers the migration on the populated fixture. `web/adaptive-routing-workflows.test.tsx` covers the strip, the panel without locks and the composer without a selector.
