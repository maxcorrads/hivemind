# Adaptive orchestration routing

Issue #120 adds an optional TypeSafe Jev policy layer that actively chooses between two execution modes:

- `single` — the receiving brain executes the Human request directly in its current model session and does not delegate it;
- `orchestrated` — the brain keeps the normal Hivemind coordinator role and delegates/coordinates workers when useful.

The feature is **opt-in**. With Jev disabled, Hivemind preserves the existing message and execution behavior and makes no TypeSafe request.

The repository also retains a separate shadow replay/scoring harness for #29/#125 benchmark data. Shadow replay is evaluation tooling; it is no longer the only implementation mode.

## Runtime behavior

Hivemind does not launch Codex, Claude, Cursor, or other external model terminals itself. Human starts those employee sessions and they join Hivemind.

Active routing therefore applies at the Hivemind instruction boundary:

```
Human sends a new request to a brain DM
  ↓
Jev enabled?
  ├─ no  → deliver the original Human message unchanged
  └─ yes → one structured Jev call
              ↓
          deterministic policy
          ├─ single
          └─ orchestrated
              ↓
          Hivemind atomically publishes:
          1. the routing directive
          2. the original Human request unchanged
```

The routing directive is a real Human-authored Hivemind assignment visible to the brain before the request.

For `single`, the directive tells that brain to perform the request itself and not delegate. If execution later reveals concrete evidence that one session cannot safely finish the work, the brain may escalate to normal orchestration and should state that reason before delegating.

For `orchestrated`, the brain follows the normal Hivemind coordinator model and may use workers, structured tasks, DMs, rooms and other existing coordination primitives.

### What is routed

Version 1 classifies only:

- new top-level Human messages;
- in a direct message whose other participant is a brain.

It does not reclassify:

- thread replies;
- public/private channel conversation;
- Human-to-worker DMs;
- bot observations;
- existing structured task events.

This keeps the active interception point narrow and prevents repeated Jev calls during an already-running conversation.

## Enable or disable Jev

Open **Adaptive routing** from the Hivemind top bar (`⇄`).

The settings panel contains:

- **Use Jev to choose single-session vs orchestrated execution** — the on/off toggle;
- **TypeSafe API key** — the credential used for Jev;
- the current Jev model alias.

Enabling requires an API key. Disabling leaves the saved key available for a later re-enable but completely bypasses Jev at runtime.

### Per-request override

In a top-level Human → brain DM, the composer exposes an execution-mode selector:

- **Auto · Jev** — use the global Jev toggle; when enabled, classify the request normally;
- **Single** — bypass Jev and explicitly run this request in the receiving brain session;
- **Orchestrated** — bypass Jev and explicitly use normal Hivemind coordination/delegation.

The override applies to one send only and resets to **Auto · Jev** after a successful request. Explicit modes remain available even when global Jev routing is disabled because they do not require an external classifier call. They are rejected outside a top-level Human → brain DM.


The key is stored in:

```
<HIVEMIND_HOME>/adaptive-routing.json
```

The file is written atomically with mode `0600`. The Human API and browser receive only:

- `enabled`;
- whether a key exists;
- a short key hint;
- the Jev model alias.

The full key is never returned to the browser after save and is never written to adaptive-routing telemetry.

## TypeSafe / Jev request

The runtime adapter uses:

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TypeSafe API key>
```

and model alias:

```
jev-latest
```

Hivemind sends one request containing six independent questions:

1. `single_agent_sufficiency` — whether one capable session can meet the quality target;
2. `complexity`;
3. `parallelizability`;
4. `coupling`;
5. `specialization_need`;
6. `coordination_need`.

Jev supplies structured Choice/Score answers with probabilities and confidence. Jev does not select a Hivemind topology directly; ordinary deterministic Hivemind code combines those signals into `single | orchestrated`.

## Privacy

When active routing is enabled, the TypeSafe request state contains only:

- the new Human request text;
- current project slug;
- current project name.

The routing state does **not** include:

- repository files or file contents;
- Git diffs;
- Hivemind message history;
- other channels/DMs;
- stored TypeSafe API key as state;
- Hivemind agent/bot credentials;
- benchmark answer keys;
- worker logs.

The TypeSafe API key is used only as the HTTP Authorization credential.

Runtime telemetry stores a SHA-256 hash and byte length of the Human request rather than persisting its text again.

## Deterministic policy

The active v1 policy intentionally remains two-way.

A high-confidence `single_agent_sufficiency=sufficient` result is accepted as `single` only while complexity, coordination need and specialization need remain below their configured bounds.

Clear coordination pressure, useful independent workstreams or specialist need selects `orchestrated`.

Low confidence or an ambiguous middle region uses the conservative fallback:

```
orchestrated
```

The thresholds remain versioned policy constants and can continue to be evaluated against the #29/#125 corpus.

## Failure behavior

Jev is optional optimization, never a correctness dependency.

These conditions fall back to `orchestrated` rather than blocking the Human request:

- timeout;
- network error;
- HTTP/provider error;
- malformed response;
- missing confidence/probabilities;
- missing usage fields;
- low confidence;
- ambiguous policy result.

The current provider timeout is bounded. After fallback, the Human request is still delivered and the brain can continue through the existing orchestration workflow.

## Delivery and retry semantics

For an actively routed request, the route directive and original Human request are committed as one Hivemind transaction. The original request body remains unchanged.

The ordinary Human send `requestId` still controls idempotency. If the browser retries a request whose send already committed, Hivemind reuses the existing Human message and does not call Jev again.

The routing directive gets its own stable mutation key for that route. No half-committed state should expose a directive without its corresponding Human request.

## Runtime telemetry

Runtime decisions are appended locally to:

```
<HIVEMIND_HOME>/adaptive-routing-decisions.jsonl
```

Records include:

- route ID;
- project ID/slug;
- request hash and byte length;
- selected strategy;
- decision/fallback reason;
- provider status and resolved model;
- Jev latency;
- provider-reported input/output token usage;
- minimum confidence;
- atomic routing signals/probabilities.

The API key and original request text are not recorded in this telemetry file.

## Benchmark shadow replay

The #29/#125 replay remains useful for evaluating whether the active policy is actually beneficial.

Use a complete real-agent cohort:

```sh
npm run benchmark:coordination:routing -- shadow \
  --input /tmp/hivemind-pilot-v1 \
  --provider typesafe \
  --decisions /tmp/hivemind-pilot-v1/routing-shadow-v1.jsonl \
  --output /tmp/hivemind-pilot-v1/routing-shadow-v1-summary.json
```

The same scorer can be used with the discriminative `clarification-v1` cohort.

The benchmark path remains separately configurable through `TYPESAFE_API_KEY` because it is a command-line evaluation harness rather than the running Hivemind server settings UI.

A retained decision file can be rescored without another provider call:

```sh
npm run benchmark:coordination:routing -- score \
  --decisions /tmp/hivemind-pilot-v1/routing-shadow-v1.jsonl \
  --output /tmp/hivemind-pilot-v1/routing-shadow-v1-rescore.json
```

### Evaluation metrics

The replay produces:

- predicted `single | orchestrated`;
- observed acceptance/defects;
- rework and duplicate work;
- clarification, handoff and recovery counts;
- wall time;
- provider tokens/cost when available;
- routing regret in tokens/wall time and comparable monetary cost;
- under-orchestration errors.

Under-orchestration remains a distinct high-severity metric:

```
router chooses single
AND single misses the quality target
AND an orchestrated condition succeeds
```

For an `orchestrated` prediction, Phase 1 still does not select among `brain_one_worker`, `brain_multi_dm` and `brain_multi_room`; benchmark regret therefore uses the cheapest observed successful orchestrated condition as a lower-bound cost.

## Future topology selection

The runtime currently decides only whether to stay in one brain session or enter Hivemind orchestration.

A later evidence-backed phase may choose among:

```
brain + 1 worker
multi-DM
room
```

and may add progressive escalation:

```
single → brain + 1 worker → multi-DM → room
```

Escalation should continue to require observable evidence such as newly discovered independent work, blocking dependencies or coordination pressure rather than elapsed time alone.
