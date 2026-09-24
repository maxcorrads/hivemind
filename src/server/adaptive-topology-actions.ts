import { randomUUID } from 'node:crypto';
import type { AdaptiveActionDeps } from "./services/ports.ts";
import { parseMentions } from '../shared/mentions.ts';
import { HiveError, type Agent, type ThreadStatus, type WaitResult } from '../shared/types.ts';
import { validated, sendInputSchema } from '../shared/api-contract.ts';
import { assignTaskSchema, taskEventSchema } from '../shared/tasks.ts';
import { roomEventSchema } from '../shared/rooms.ts';
import type { JevAdvice } from '../shared/adaptive-topology.ts';
import type { ActionHint, BrainAction } from './adaptive-topology.ts';

/**
 * Agent coordination actions (#211). The action always runs first and is never blocked, checked or reshaped by Jev.
 * For a brain acting on an open Human request (same thread or channel), Hivemind then asks Jev and returns its
 * non-binding advice as `jevAdvice`. The field is absent when Jev is off, the brain serves no open request there, or
 * Jev gave no usable answer (#214). Workers never trigger Jev and receive no advice.
 *
 * A legacy `executionId` from older clients is dropped at ingress (api-input.ts) and never reaches these actions.
 */
type Advised = { jevAdvice?: JevAdvice };
const advised = (advice: JevAdvice | null): Advised => advice ? { jevAdvice: advice } : {};

async function advise(deps: AdaptiveActionDeps, actor: Agent, action: BrainAction): Promise<Advised> {
  return actor.role === 'brain' ? advised(await deps.adaptiveTopology.adviseBrainAction(actor, action)) : {};
}
/** A retried request (same requestId) returns the latest advice without asking Jev again. */
function retried(deps: AdaptiveActionDeps, actor: Agent, hint: ActionHint): Advised {
  return actor.role === 'brain' ? advised(deps.adaptiveTopology.latestAdvice(actor, hint)) : {};
}

export async function sendAdaptiveAgentMessage(deps: AdaptiveActionDeps, actor: Agent, channelRef: string, raw: unknown) {
  const input = validated(sendInputSchema, raw);
  const channel = deps.channels.getChannel(channelRef, actor.projectId);
  if (!deps.channels.canSeeChannel(actor, channel) || !deps.channels.canPost(actor, channel)) throw new HiveError(403, 'Cannot send to this channel');
  const body = input.body ?? '', requestId = input.requestId ?? randomUUID();
  const messageInput = { ...input, body, channel: channel.id, requestId };
  const hint = { channelId: channel.id, threadId: input.threadId ?? undefined };
  if (deps.messages.hasActiveSendRequest(actor, channel.id, requestId)) {
    const message = deps.messages.postMessage(actor, messageInput);
    return { ok: true, seq: message.seq, id: message.id, ...retried(deps, actor, hint) };
  }
  if (!body.trim() && !input.attachmentIds?.length) throw new HiveError(400, 'Empty message');
  if (input.threadId && deps.messageQueries.getMessageById(input.threadId).channelId !== channel.id)
    throw new HiveError(400, 'Thread is not in this channel');
  const message = deps.messages.postMessage(actor, messageInput);
  // Only labels the Jev trigger in the Routing log: a message that assigns work or reaches a worker is a delegation.
  const roster = actor.role === 'brain' ? deps.identity.listAgents(actor) : [];
  const reached = new Set([...parseMentions(body, roster),
    ...(input.recipients ?? []).map(name => deps.identity.getAgentByName(name)?.id),
    ...(channel.type === 'dm' ? channel.memberIds : [])]);
  const delegates = input.eventType === 'assignment' || roster.some(agent => agent.role === 'worker' && reached.has(agent.id));
  return { ok: true, seq: message.seq, id: message.id, ...await advise(deps, actor, {
    kind: delegates ? 'delegation_attempt' : 'brain_message', ...hint, eventType: input.eventType, summary: body }) };
}

export async function assignAdaptiveTask(deps: AdaptiveActionDeps, actor: Agent, raw: unknown) {
  if (actor.role !== 'brain') throw new HiveError(403, 'Only a brain assigns work');
  const input = validated(assignTaskSchema, raw);
  const hint = { channelId: input.channel };
  if (deps.tasks.hasRequest(actor.id, input.requestId)) return { ...deps.tasks.assign(actor, input), ...retried(deps, actor, hint) };
  const result = deps.tasks.assign(actor, input);
  return { ...result, ...await advise(deps, actor, { kind: 'delegation_attempt', channelId: input.channel,
    eventType: 'assign', summary: input.contract.objective }) };
}

export async function mutateAdaptiveTask(deps: AdaptiveActionDeps, actor: Agent, taskId: string, raw: unknown) {
  const input = validated(taskEventSchema, raw), action = input.action;
  const task = deps.tasks.get(actor, taskId);
  const hint = { channelId: task.channelId, threadId: taskId };
  if (deps.tasks.hasRequest(actor.id, input.requestId)) return { ...deps.tasks.event(actor, taskId, input), ...retried(deps, actor, hint) };
  const result = deps.tasks.event(actor, taskId, input);
  return { ...result, ...await advise(deps, actor, { kind: action.type === 'revise' ? 'delegation_attempt' : 'task_event',
    ...hint, taskId, eventType: action.type, summary: action.type === 'revise' ? action.contract.objective : action.type }) };
}

export async function mutateAdaptiveRoom(deps: AdaptiveActionDeps, actor: Agent, channelId: string, raw: unknown) {
  const input = validated(roomEventSchema, raw), action = input.action;
  const hint = { channelId };
  if (deps.rooms.hasRequest(actor.id, input.requestId)) return { ...deps.rooms.event(actor, channelId, input), ...retried(deps, actor, hint) };
  const result = deps.rooms.event(actor, channelId, input);
  return { ...result, ...await advise(deps, actor, { kind: 'room_event', channelId, eventType: action.type, summary: `room ${action.type}` }) };
}

export async function setAdaptiveThreadStatus(deps: AdaptiveActionDeps, actor: Agent, threadId: string, status: ThreadStatus | null) {
  const root = deps.messageQueries.getMessageById(threadId);
  const thread = deps.messages.setThreadStatus(actor, threadId, status);
  return { thread, ...await advise(deps, actor, { kind: 'thread_status', channelId: root.channelId, threadId,
    eventType: status ?? 'none', summary: `thread status ${status}` }) };
}

/**
 * A wait never calls Jev (#214). When it delivered mail from a thread or channel with an open request, it carries that
 * request's latest advice, e.g. the advice Jev gave in the background for the Human message just delivered.
 */
export function adviseAfterWait(deps: AdaptiveActionDeps, actor: Agent, result: WaitResult): Advised {
  if (actor.role !== 'brain' || result.idle) return {};
  const hints: ActionHint[] = [
    ...(result.mail ?? []).map(item => ({ channelId: item.channelId, threadId: item.rootId })),
    ...[...result.messages, ...result.mentions].map(item => ({ channelId: item.channelId, threadId: item.threadId ?? item.id })),
  ].reverse();
  return hints.length ? advised(deps.adaptiveTopology.latestAdvice(actor, ...hints)) : {};
}
