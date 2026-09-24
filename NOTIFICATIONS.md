# Targeted notifications

Notification rules decide which existing messages reach an agent's `wait`. They do
not grant channel access, authorize work, launch agents, or change task state. This
works without room contracts or provider-specific plugins. An optional active
[channel contract](ROOMS.md) makes its coordinator the default observer of bot
observations in that channel, including public channels; explicit subscriptions
still override that default. The contract, not the bot content, records the mandate.

## Routing

Existing untyped chat keeps its defaults: private/DM membership and the brains room
wake eligible agents; public chatter does not. Authors never receive their own mail.

- `send` / `attach` accept optional `recipients: ["Name", ...]` (CLI:
  `--recipients Name,Name`). Each person must already have access; workers still
  cannot target Human. Other room peers do not wake unless mentioned or explicitly
  subscribed. These are notification recipients, not private visibility: everyone
  with channel access can still read the message in history/UI.
  A brain targeting `Human` also reaches **For you** (live and after reload) and
  the existing Telegram notification policy, including attachment-only messages.
  Telegram mute and non-chat exclusions still apply; a recipient and a textual
  mention of the same person produce one inbox entry, not two.
- Structured task events automatically target the other participant (and the old
  worker on reassignment). Observers can explicitly subscribe to the task root.
- The MCP `subscriptions` tool takes an explicit `mode` (#218):
  `{mode:"list"}` lists your rules; `{mode:"set", channel, threadId?, eventTypes}`
  changes **your own** persistent rule. A root-thread/task rule overrides its
  channel rule. `message` selects untyped messages; other values are the message
  event types below. Empty `eventTypes: []` mutes non-directed traffic.
- `{mode:"reset", channel, threadId?}` removes the explicit rule, restoring
  the channel rule or defaults. **Reset is not mute.** Subscriptions neither invite
  agents nor replay previously scanned history. Use history explicitly for catch-up.
- Direct recipients, mentions and control bypass subscription filters. An
  already-offered receipt still replays even if a rule changes; current channel
  access and session identity are always checked. A mute can suppress non-directed
  Human/bot chat too: address the intended agent for decisions it must receive.

No UI preference panel is added in this increment; configuration is through MCP,
CLI or authenticated agent HTTP endpoints. Web history continues to show originals.

```sh
hivemind subscriptions set --channel work --thread ROOT_UUID --events blocker,decision,action_required
hivemind subscriptions set --channel work --mute
hivemind subscriptions list
hivemind subscriptions reset --channel work --thread ROOT_UUID
hivemind send --channel work --recipients Aster --event-type decision --body "Use the agreed option."
```

HTTP: `GET /api/agent/subscriptions`, `POST /api/agent/subscriptions` with the set
payload, `POST /api/agent/subscriptions/reset` with the scope. Identity comes from
the authenticated session; a caller cannot set another agent's rule.

## Classes, evidence and receipts

Optional types: `assignment`, `decision`, `blocker`, `question`, `action_required`,
`progress`, `acknowledgement`. No keyword or language-model classifier is used.
Bot types are still observations, not instructions or priority authority.

`acknowledgement` is only “thanks/received”, not a question, result or acceptance of
work. Agent/bot acknowledgement-only chat does not enter the model inbox, even with
a mention/recipient. Human messages, control, structured task events and attachments
are excluded from that suppression. The transport `ack_delivery` itself creates no
chat message or peer wake. Task acceptance is a canonical event and is delivered.

Non-directed progress without task metadata or attachments waits at most **250 ms
from the oldest pending update**, not 250 ms after every new update. A critical or
other non-routine message flushes the batch immediately. Compact progress groups
keep exact original IDs for `expand_digest`; raw delivery and history retain bodies.
Different roots/authors and important evidence are never folded into one progress
item. Explicitly targeted messages stay full too. No message is deleted or silently
substituted by the last progress string.

The batch receipt covers the exact selected originals, including summarized ones.
Replays retain its ID/selection. ACK never advances the cursor beyond an omitted
addressed message; out-of-order critical deliveries use the existing sparse receipt
ledger. Suppressed/unsubscribed chat remains readable in history but does not count
as delivered work.

## Fairness and delivery targets

Within each bounded scan (256 headers), the oldest eligible item always progresses;
up to two critical slots then prioritize direct mail/control, Human messages, task
events, assignments, decisions, blockers, questions and action requests. Remaining
slots are round-robin by channel and root/thread. Caps (8 channels, 100 originals for
brains / 8 for workers, 64 KiB) still apply. Continuous newer priority traffic cannot
starve the oldest item; a quiet task inside the window competes before a noisy
thread gets another round.

**Target for an active idle waiter with capacity in the current window:** blockers
and Human decisions incur no intentional batching delay (fake-clock tests require
delivery at the event's timestamp; local operational target under one second).
This is not an end-to-end latency SLA. Mail beyond the scan window needs additional
bounded pages; pending unconfirmed batches replay before newer events; offline or
busy agents must return to `wait`. A queued control/cancellation message cannot
instantly interrupt code, tools or a model running inside an external host.

## Transport retries

Successful idle HTTP long-poll cadence is unchanged. Empty pages and routine
`retryAfterMs` stay inside MCP, not model turns. Failures use exponential equal
jitter: first retry 750–1500 ms, doubling to a 15–30 s range. A successful HTTP poll
resets the backoff. Permanent auth/session/protocol failures still stop; host
cancellation interrupts the retry timer.

## Verification and measurement limits

`npm run test:notifications` exercises fake-clock batching, critical delivery,
ACK-only silence, reconnect jitter, fairness, restart, access boundaries, receipt
replay and real MCP/CLI clients on an isolated local hive. The full suite also
checks prior byte/scan limits, tasks and exact digest recovery.

The controlled one-task replay compares model-returning waits to the previous
private-room broadcast rule through an explicit reference-policy adapter in the
same real wait/ACK pipeline (not an old server binary). Both runs reach structured
`accepted_complete` with the same 20-message history. For this fixture, eight
progress updates and eight thanks produce 18 vs 3 model-returning waits and 18 vs
10 addressed wake signals; HTTP calls are tracked separately. It is a deterministic
protocol comparison with a scripted consumer, **not** a measured model-token or
productivity saving. Real-agent
before/after comparison should record completed tasks, notification wake signals,
model-returning waits, blocker/decision latency, and undelivered evidence over the
same workload. Do not change the successful idle polling cadence based on HTTP
request counts alone.
