import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ToolName } from "./tool-text.ts";

/**
 * MCP annotations of every tool: what a client may assume about a call before it runs it. Clients act on them (Codex
 * decides from them whether to ask the person, Claude Code runs read-only calls side by side), so each one states what
 * the server does, never what would be convenient. The rules, and what each client does with them, are in
 * docs/agent-connection.md ("Tool annotations").
 *
 * - Read-only: the call changes nothing in the hive, on disk or anywhere else. The caller's own presence and activity,
 *   which every request records, do not count. src/mcp/tool-annotations.test.ts holds every read-only tool to this.
 * - Destructive: the call can end, cancel or discard something that is not the caller's own to set again: another
 *   session, a worker's terminal, open tasks, a worker's task memory.
 * - Repeatable: the same call again succeeds, answers the same and changes nothing more.
 * - Outside: the call reaches a system of the agent's choosing outside the hive. Mirrors the Human set up (Telegram,
 *   Jev advice) relay hive content to services the Human chose and do not count.
 */
const READS: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const writes = ({ destructive = false, repeatable = false, outside = false } = {}): ToolAnnotations =>
  ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: repeatable, openWorldHint: outside });

export const TOOL_ANNOTATIONS: Record<ToolName, ToolAnnotations> = {
  // resume cuts off the earlier session of that name; another process resuming it gets a new session each time.
  join: writes({ destructive: true }),
  whoami: READS,
  agents: READS,
  bot_tools: READS,
  // Runs a project bot's executable with the caller's arguments: what it does is the bot's own.
  call_bot_tool: writes({ destructive: true, outside: true }),
  channels: READS,
  search: READS,
  history: READS,
  expand_digest: READS,
  // Without requestId every call posts another message.
  send: writes(),
  // The caller's own rule: set and reset replace it, and the caller can set it again.
  subscriptions: writes({ repeatable: true }),
  get_room: READS,
  // archive cancels every open task of the channel, which closes the terminals of their task-bound workers.
  room_event: writes({ destructive: true, repeatable: true }),
  assign_task: writes({ repeatable: true }),
  job_event: writes({ repeatable: true }),
  worker_templates: READS,
  request_worker: writes({ repeatable: true }),
  // Archives the worker and closes its terminal.
  release_worker: writes({ destructive: true, repeatable: true }),
  get_worker_capabilities: READS,
  // The same expectedRevision is refused the second time.
  set_capabilities: writes(),
  worker_match_suggest: READS,
  worker_match_outcome: writes({ repeatable: true }),
  // Its requestId is remembered for 24 hours.
  worker_match_override: writes({ repeatable: true }),
  get_handoffs: READS,
  get_task: READS,
  get_task_timeline: READS,
  preview_task_claim: READS,
  // An accepted review archives a task-bound worker and closes its terminal; revise can move the task to another worker.
  task_event: writes({ destructive: true, repeatable: true }),
  // Offers mail: it records the delivery and moves the inbox on.
  wait: writes(),
  ack_delivery: writes({ repeatable: true }),
  // The same name is refused the second time.
  create_channel: writes(),
  // With Jev on, every call other than done asks for advice again.
  set_thread_status: writes(),
  // Every call posts another "invited" line.
  invite: writes(),
  // Tells a worker to discard its task memory; every call sends the order again.
  clear_context: writes({ destructive: true }),
  attach: writes(),
  // Writes the file into .hivemind-inbox of the workspace, at the same path every time.
  fetch_file: writes({ repeatable: true }),
  react: writes({ repeatable: true }),
};
