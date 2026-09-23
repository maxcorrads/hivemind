/**
 * Agent-facing MCP text. A tool description says what the tool does, its
 * required fields, and at most one pointer to the standing orders, which are
 * the single home of behavioural rules. Budget: 400 characters per tool
 * (asserted in src/shared/agent-instructions.test.ts).
 */
export const TOOL_DESCRIPTIONS = {
  join: "Register this terminal as a brain or worker (workers also set seniority) in one project: join from its worktree or pass project. resume=<your name> returns to your identity without credentials, superseding its older session. Repeated join keeps this process's identity; another identity needs a new MCP process.",
  whoami: "Your name, role, project and online flag.",
  standing_orders: "Your full standing orders: every rule you follow. Reread them after a resume or a Hivemind upgrade.",
  agents: "Project roster with online/offline status.",
  channels: "Channels and DMs you can see; unread=true adds unread counts.",
  search: "Find messages in this project by body, seq, author, channel, mention, attachment name or reaction; workers search only rooms they can see. Page with before=oldest seq of the last page.",
  history: "Read a channel or DM: by default the latest 20 roots, or the first 20 messages of threadId. Page forward with since or backward with before, without gaps. For mail from wait, pass its channelId (ch is only a display label).",
  expand_digest: "Read the exact messages behind a wait digest: pass its expand object unchanged; if hasMore, repeat with afterSeq=nextAfterSeq. Read-only: it neither ACKs nor completes work. File metadata only (fetch_file for contents).",
  send: "Post body to channel, or by name with to (opens the DM). Reply to mail with its channelId as channel and rootId as threadId. requestId makes retries idempotent for 24 hours (rules in standing orders). Workers cannot @Human or open a Human DM.",
  subscriptions: "List your persistent wake subscriptions per channel and thread.",
  set_subscription: "Set which event types wake you for a channel or root thread/task (observers follow tasks this way). [] mutes non-directed traffic; thread rules beat channel rules; direct recipients, @mentions and control always arrive. Filters match types, not content, apply to mail not yet offered, and never grant access or replay history.",
  reset_subscription: "Remove your explicit rule for a channel/thread, falling back to the channel rule or defaults (DMs, private channels, #brains and task participants wake; public channels are quiet). Not a mute: use set_subscription with [].",
  get_room: "Read a channel's room contract: revision, coordinator, rules, task fences and source-suspension reports (channel: UUID, name or #name). history=true with beforeRevision pages 20 older audit snapshots; beforeTask pages tasks.",
  room_event: "Change a room. Coordinating brain: configure, archive (running=finish|stop) or reopen with the Human's humanInstructionSeq; staff, reconcile, summarize. Worker: acknowledge (copy contractVersion from get_room) or stopped. Read get_room after a conflict. Room rules are in standing orders. action is ALWAYS an object with a literal type field; never omit it. Shapes: {type:\"configure\",contract,reason} | {type:\"staff\",participants:[{name,boundary}],reason} | {type:\"archive\",running?:\"finish\"|\"stop\",reason} | {type:\"reopen\",resumeSources,reason} | {type:\"reconcile\",taskId,decision:\"continue\"|\"stop\",reason} | {type:\"acknowledge\",contractVersion} | {type:\"stopped\",taskId,reason} | {type:\"summarize\",summary,artifacts}.",
  assign_task: "Brain only: assign a versioned task contract to one worker, in a new DM task thread or in channel (UUID/name/#name) if you are both members; in a contracted room also pass room. Pick requestId once and reuse it on retry. The contract is data, not code; its references grant no permissions.",
  request_human_decision: "Assigning brain only: ask Human a precise question fenced to the current task revision, with options and impacts, an explicitly uncertain recommendation, evidence and affected workers. Human answers in the decision thread. A newer task revision makes it stale; the recommendation is advisory and never applies on expiry.",
  get_decision: "Read one Human decision request: current or stale state, answer, and per-recipient delivery receipts (transport only).",
  get_task_decisions: "List up to 20 Human decision requests linked to a visible task. Stale or expired recommendations never auto-apply.",
  decision_event: "Requesting brain only: withdraw an awaiting Human decision request at its current revision. Task state does not change. action is {type:\"withdraw\",reason}.",
  get_worker_capabilities: "Read a worker's opt-in capability card in your project; workerId is a UUID or exact visible name (ambiguous names fail). Workers read only their own. Declarations are not verified.",
  set_capabilities: "Worker only: declare or update your capability card at its current revision (0 for a new card); enabled=false opts out. Declarations never permit launching or changing a runtime.",
  suggest_workers: "Brain only, read-only: rank workers for a visible task by declared capabilities, context and reviewed results (cold starts stay eligible; review mode excludes the implementer). Cost and real runtime quality are unknown. Never assigns or changes a model; small coupled work may be better kept in one task.",
  record_routing_outcome: "Assigning brain only: classify a reviewed task's routing outcome, confirming the worker capability revision and category. Verdict and worker come from the task, not supplied scores; a task counts once; runtime configuration is unverified.",
  record_routing_override: "Assigning brain only: record in the task thread which worker you chose and why. Not an assignment or a ranking; ownership, claims and running terminals stay unchanged. Reuse requestId on retry.",
  get_handoffs: "List up to five unfinished tasks assigned to you (worker) or by you (brain), with checkpoint freshness and next action; page with beforeTask=nextCursor. Reports are not verified repository state.",
  get_handoff: "Read one task checkpoint: age, current contract/revision and stale or later-message warnings. Later unsaved work may exist; it restores no model context and authorizes no scope change.",
  get_task: "Read a task visible to you: contract, revision, assignee, receipt, state, reported result and review. Its events are in history with channelId and threadId=task.id.",
  get_task_timeline: "Read a visible task's protocol timeline: messages, actions, transport source, delivery offer/ACK times and wake reasons; causeMessageId links are explicit, thread parents inferred. It records no reasoning, tokens, environment or file contents, and grants no authority.",
  export_task_timeline: "Export a visible task's timeline as a redacted, deterministic replay fixture (bodies hashed, names aliased, artifacts counted). The fixture never resends messages or executes code.",
  preview_task_claim: "Brain only, read-only: preview declared intent overlaps for paths on a task; returns the task revision and claimVersion pairs to acknowledge intentional overlap. Reserves nothing; undeclared intent is not excluded; claiming rechecks versions.",
  task_event: "Task lifecycle action. Worker: accept, reject, block, checkpoint, result. Assigning brain: revise, review. Claims, after preview_task_claim: claim/renew_claim (channel-visible brain), release_claim (coordinator or assigner), reconcile_claim (assigner; expired claims need it). Claims never execute or reassign work. accept, result and accepted review need immediate dependencies accepted-complete. action is ALWAYS an object with a literal type field; never omit type or put JSON inside it. Shapes: {type:\"accept\"} | {type:\"reject\",reason} | {type:\"block\",needed} | {type:\"checkpoint\",checkpoint:{completedSteps,unresolvedQuestions,nextAction,artifacts,checks,evidenceSeqs}} | {type:\"result\",result:{summary,artifacts,checks:[{name,outcome:\"passed\"|\"failed\"|\"not_run\",evidenceSeqs}],gaps,evidenceSeqs}} | {type:\"review\",decision:\"accepted\"|\"changes_requested\",summary,evidenceSeqs} | {type:\"revise\",reason,worker,contract} | {type:\"claim\",leaseSeconds,paths,overlapAcknowledgements} | {type:\"renew_claim\",leaseSeconds,overlapAcknowledgements} | {type:\"release_claim\",reason} | {type:\"reconcile_claim\",reason,leaseSeconds,paths,overlapAcknowledgements}. Use [] for empty lists.",
  wait: "Sleep until you have mail, then return it with delivery.id for ack_delivery. Call once with no arguments; the wait loop is in standing orders.",
  ack_delivery: "Confirm receipt of the exact delivery.id returned by wait, before acting on it. Receipt only: not task acceptance, completion or a reply to the sender. Safe to retry.",
  create_channel: "Brain only: create a public (default) or private channel in your project, optionally with members.",
  set_thread_status: "Set an optional status on a free-form thread: open, in_progress, blocked or done. Structured tasks change state only through task_event.",
  invite: "Brain only: invite existing agents or bots of your project into a channel you can access. It creates no bot and starts no integration.",
  clear_context: "Brain only: tell a worker to discard its task memory and wait.",
  attach: "Upload a local file and post it with an optional body. Targeting and requestId work as in send.",
  fetch_file: "Download an attachment (by id, or by message seq and index) into .hivemind-inbox in this workspace. Images also return a small preview.",
  react: "Set or remove (present=false) a reaction on a message seq: 👍 👎 👀 🚩 ✅ ❓. Repeating the same state is safe.",
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;

/** Parameter descriptions declared inline in src/mcp/index.ts. */
export const PARAM_DESCRIPTIONS = {
  recipients: "Names already in the channel to wake; others wake only if mentioned or subscribed. Grants no access.",
  eventType: "acknowledgement stays history-only for agents unless it carries files or task evidence. No type grants authority.",
  traceId: "Optional observability trace UUID; task messages already use their task ID.",
  causeMessageId: "Optional message in this project that this one explicitly answers; timelines label it explicit.",
  workerId: "Worker UUID or exact visible worker name.",
} as const;

/** Texts returned by join and search results. */
export const JOIN_SESSION = "Held privately by this MCP process; to come back later, join with resume=<your name>.";
export function joinNext(created: boolean, handoffs: boolean): string {
  return [
    created ? "Follow standingOrders." : "Orders unchanged: if they are not in your context, call standing_orders.",
    handoffs ? "Read get_handoff for relevant unfinished tasks before acting; saved reports may be stale." : "",
    "Then call wait once with no arguments and stay silent while it runs.",
  ].filter(Boolean).join(" ");
}
export const SEARCH_NEXT = "More hits: repeat search with the same q and before set to the oldest seq in this page.";
