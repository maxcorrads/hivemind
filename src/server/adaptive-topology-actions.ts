import { createHash, randomUUID } from 'node:crypto';
import type { AdaptiveActionDeps } from "./services/ports.ts";
import { parseMentions } from '../shared/mentions.ts';
import { HiveError, type Agent, type ThreadStatus } from '../shared/types.ts';
import { validated, sendInputSchema } from '../shared/api-contract.ts';
import { assignTaskSchema, taskEventSchema } from '../shared/tasks.ts';
import { roomEventSchema } from '../shared/rooms.ts';
import { bindAdaptiveMessage, clearAdaptivePermit, coordinateMutation, coordinationEventId, permitAdaptiveTask,
  type DeferRouting } from './adaptive-topology-admission.ts';
import { readAdaptiveCapacity } from './adaptive-topology-capacity.ts';
import type { AdaptiveAgentPolicy, AdaptiveCoordinationEvent } from './adaptive-topology.ts';

/** Only brains coordinate through Jev; worker activity is never classified. */
function event(actor: Agent, family: string, requestId: string,
  rest: Omit<AdaptiveCoordinationEvent, 'actorId' | 'actorRole' | 'eventId'>): AdaptiveCoordinationEvent {
  if (actor.role !== 'brain') throw new HiveError(403, 'Only brains coordinate adaptive work');
  const payload = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  return { ...rest, actorId: actor.id, actorRole: actor.role,
    eventId: coordinationEventId(actor.id, family, `${requestId}:${payload}`) };
}
function taskRetry(deps: AdaptiveActionDeps, actor: Agent, requestId: string): boolean {
  return deps.tasks.hasRequest(actor.id, requestId);
}
function authenticate(deps: AdaptiveActionDeps, actor: Agent, token?: string): void {
  if (token !== undefined && deps.identity.agentByToken(token).id !== actor.id) throw new HiveError(401, 'Authenticated identity changed');
}
function reauthorize(deps: AdaptiveActionDeps, actor: Agent, before: unknown, token?: string): void {
  authenticate(deps, actor, token);
  if (deps.identity.sessionFingerprint(actor.id) !== before)
    throw new HiveError(401, 'Credentials changed while revalidating coordination');
}
/** Project-wide revalidation never holds the acting brain's lane; it runs once the mutation has left it. */
function deferCapacityChange(deps: AdaptiveActionDeps, actor: Agent, defer: DeferRouting, eventId: string, exceptExecution?: string): void {
  if (actor.role !== 'brain') return;
  defer('capacity revalidation', () => deps.adaptiveTopology.capacityChanged(actor, eventId, exceptExecution));
}
type PostCommitRouting = { adaptiveRouting: AdaptiveAgentPolicy | null; routingWarning?: string };
/**
 * The mutation already committed: routing that follows it may degrade, but must never turn a committed
 * mutation into a reported failure (a retry would find nothing left to evaluate).
 */
async function afterCommit(deps: AdaptiveActionDeps, actor: Agent, coordination: AdaptiveCoordinationEvent): Promise<PostCommitRouting> {
  try { return { adaptiveRouting: await deps.adaptiveTopology.afterAgentAction(actor, coordination) }; } catch (error) {
    console.error(`Adaptive routing after a committed action by ${actor.name} failed`, error instanceof Error ? error.message : String(error));
    // Only public HiveError reasons reach the agent and the Human audit; anything else stays in the server log.
    const reason = error instanceof HiveError ? error.message : 'internal routing error';
    const routingWarning = `Committed; adaptive routing was not updated: ${reason}`;
    deps.adaptiveTopology.recordRoutingWarning(actor, coordination, routingWarning);
    return { adaptiveRouting: null, routingWarning };
  }
}

export function sendAdaptiveAgentMessage(deps: AdaptiveActionDeps, actor: Agent, channelRef: string, raw: unknown, token?: string) {
  const { executionId, ...input } = validated(sendInputSchema, raw);
  return coordinateMutation(deps, actor, async () => {
    authenticate(deps, actor, token);
    const channel = deps.channels.getChannel(channelRef, actor.projectId);
    if (!deps.channels.canSeeChannel(actor, channel) || !deps.channels.canPost(actor, channel)) throw new HiveError(403, 'Cannot send to this channel');
    const body = input.body ?? '', requestId = input.requestId ?? randomUUID();
    const messageInput = { ...input, body, channel: channel.id, requestId };
    if (deps.messages.hasActiveSendRequest(actor, channel.id, requestId)) {
      const message = deps.messages.postMessage(actor, messageInput);
      return { ok: true, seq: message.seq, id: message.id, adaptiveRouting: deps.adaptiveTopology.forAgent(actor, executionId) };
    }
    if (!body.trim() && !input.attachmentIds?.length) throw new HiveError(400, 'Empty message');
    if (input.threadId && deps.messageQueries.getMessageById(input.threadId).channelId !== channel.id)
      throw new HiveError(400, 'Thread is not in this channel');
    if (actor.role !== 'brain') {
      if (executionId) throw new HiveError(400, 'Only a brain declares an adaptive executionId');
      const message = deps.messages.postMessage(actor, messageInput);
      return { ok: true, seq: message.seq, id: message.id };
    }
    const roster = deps.identity.listAgents(actor);
    const mentioned = new Set(parseMentions(body, roster));
    const explicit = new Set([
      ...(input.recipients ?? []).map(name => deps.identity.getAgentByName(name)?.id).filter((id): id is string => Boolean(id)),
      ...(channel.type === 'dm' ? channel.memberIds : []),
    ]);
    const directed = new Set([...mentioned, ...explicit]);
    // An @mention delegates only to a worker who will actually receive this message; naming any other
    // worker (e.g. reporting "@Worker finished" to the Human) is a plain reference, not new work.
    const targets = roster.filter(a => a.role === 'worker' &&
      (explicit.has(a.id) || (mentioned.has(a.id) && deps.channels.canSeeChannel(a, channel) && deps.channels.canPost(a, channel))));
    const room = deps.rooms.peek(channel.id);
    if (room && directed.size === 0) {
      for (const id of room.participantIds) { const worker = roster.find(a => a.id === id); if (worker) targets.push(worker); }
    }
    // Sender-declared progress/decision labels are not authority to contact a new worker.
    // Only a known, still-open assignment thread of one active execution continues without admitting new work.
    const bound = input.threadId && targets.length && deps.adaptiveTopology.hasActive(actor) &&
      deps.messageQueries.threadStatus(input.threadId) !== 'done'
      ? new Set(targets.map(worker => {
        const delegated = deps.adaptiveTopology.store.delegationExecution(input.threadId!, worker.id);
        if (delegated !== undefined) return delegated;
        const linked = deps.adaptiveTopology.store.taskExecution(input.threadId!);
        return linked !== undefined && deps.tasks.isOpenFor(input.threadId!, worker.id) ? linked : null;
      })) : null;
    const threadExecution = bound?.size === 1 ? [...bound][0] : null;
    const continuing = Boolean(threadExecution && deps.adaptiveTopology.forAgent(actor, threadExecution) &&
      (!executionId || executionId === threadExecution));
    const inertAcknowledgement = input.eventType === 'acknowledgement' && !input.attachmentIds?.length;
    const newWork = !inertAcknowledgement && (input.eventType === 'assignment' || (targets.length > 0 && !continuing));
    const coordination = event(actor, 'message', requestId, {
      kind: newWork ? 'delegation_attempt' : 'brain_message',
      channelId: channel.id, taskId: input.threadId && deps.tasks.has(input.threadId) ? input.threadId : undefined,
      threadId: input.threadId ?? undefined, summary: body, eventType: input.eventType,
      workerName: newWork && targets.length === 1 ? targets[0]!.name : undefined,
      usesRoom: newWork ? Boolean(room) : undefined,
      // Continuing a known thread may be attributed implicitly; new delegation must name its execution.
      executionId: executionId ?? (continuing && !newWork ? threadExecution! : undefined),
    });
    const credential = deps.identity.sessionFingerprint(actor.id);
    const policy = await deps.adaptiveTopology.beforeBrainAction(actor, coordination);
    reauthorize(deps, actor, credential, token);
    const message = deps.messages.postMessage(actor, messageInput, newWork
      ? posted => bindAdaptiveMessage(deps, actor, posted, targets.map(worker => worker.id), policy) : undefined);
    return { ok: true, seq: message.seq, id: message.id, adaptiveRouting: policy };
  });
}

export function assignAdaptiveTask(deps: AdaptiveActionDeps, actor: Agent, raw: unknown, token?: string) {
  if (actor.role !== 'brain') throw new HiveError(403, 'Only a brain assigns work');
  const { executionId, ...input } = validated(assignTaskSchema, raw);
  return coordinateMutation(deps, actor, async defer => {
    authenticate(deps, actor, token);
    if (taskRetry(deps, actor, input.requestId)) return { ...deps.tasks.assign(actor, input), adaptiveRouting: deps.adaptiveTopology.forAgent(actor, executionId) };
    const coordination = event(actor, 'task', input.requestId, { kind: 'delegation_attempt', executionId,
      channelId: input.channel, summary: input.contract.objective, workerName: input.worker, usesRoom: Boolean(input.room) });
    const policy = await deps.adaptiveTopology.beforeBrainAction(actor, coordination);
    authenticate(deps, actor, token);
    permitAdaptiveTask(deps, actor, input, policy);
    // The permit is created and consumed synchronously: nothing can interleave before it is cleared.
    let result: ReturnType<AdaptiveActionDeps["tasks"]["assign"]>;
    try { result = deps.tasks.assign(actor, input); } finally { clearAdaptivePermit(deps, actor.id); }
    deferCapacityChange(deps, actor, defer, input.requestId, policy?.executionId);
    return { ...result, adaptiveRouting: policy ? deps.adaptiveTopology.forAgent(actor, policy.executionId) : null };
  });
}

export function mutateAdaptiveTask(deps: AdaptiveActionDeps, actor: Agent, taskId: string, raw: unknown, token?: string) {
  const { executionId, ...input } = validated(taskEventSchema, raw), action = input.action;
  return coordinateMutation(deps, actor, async defer => {
    authenticate(deps, actor, token);
    const task = deps.tasks.get(actor, taskId);
    // TaskStore owns claim permissions and revision conflicts; routing must not replace a 409 with its own 403.
    // Workers never drive Jev; only the assigning brain's lifecycle actions are evaluated.
    const coordinating = actor.role === 'brain' && actor.id === task.assignerId;
    if (actor.role !== 'brain' && executionId) throw new HiveError(400, 'Only a brain declares an adaptive executionId');
    if (taskRetry(deps, actor, input.requestId)) return { ...deps.tasks.event(actor, taskId, input), adaptiveRouting: deps.adaptiveTopology.forAgent(actor, executionId) };
    let policy: AdaptiveAgentPolicy | null = null;
    const coordination = coordinating ? event(actor, 'task', input.requestId, {
      kind: action.type === 'revise' ? 'delegation_attempt' : 'task_event', channelId: task.channelId, taskId, threadId: taskId,
      eventType: action.type, summary: action.type === 'revise' ? action.contract.objective : action.type,
      workerName: action.type === 'revise' ? action.worker : undefined,
      usesRoom: action.type === 'revise' ? Boolean(task.room) : undefined, executionId,
    }) : null;
    if (action.type === 'revise') {
      if (actor.id !== task.assignerId || actor.role !== 'brain') throw new HiveError(403, 'Only the assigning brain revises work');
      policy = await deps.adaptiveTopology.beforeBrainAction(actor, coordination!);
      authenticate(deps, actor, token);
      permitAdaptiveTask(deps, actor, { requestId: input.requestId, worker: action.worker,
        channel: task.channelId, contract: action.contract }, policy);
    }
    let result: ReturnType<AdaptiveActionDeps["tasks"]["event"]>;
    try { result = deps.tasks.event(actor, taskId, input); } finally { clearAdaptivePermit(deps, actor.id); }
    // Committed. The brain's review is evaluated after the mutation reaches its safe checkpoint.
    const routing = coordination && action.type !== 'revise'
      ? await afterCommit(deps, actor, coordination) : { adaptiveRouting: policy };
    deferCapacityChange(deps, actor, defer, input.requestId, routing.adaptiveRouting?.executionId);
    return { ...result, ...routing };
  });
}

export function mutateAdaptiveRoom(deps: AdaptiveActionDeps, actor: Agent, channelId: string, raw: unknown, token?: string) {
  const { executionId, ...input } = validated(roomEventSchema, raw), action = input.action;
  return coordinateMutation(deps, actor, async () => {
    authenticate(deps, actor, token);
    const room = deps.rooms.view(actor, channelId).room;
    if (actor.role !== 'brain' && executionId) throw new HiveError(400, 'Only a brain declares an adaptive executionId');
    if (deps.rooms.hasRequest(actor.id, input.requestId))
      return { ...deps.rooms.event(actor, channelId, input), adaptiveRouting: deps.adaptiveTopology.forAgent(actor, executionId) };
    if (actor.role !== 'brain') return { ...deps.rooms.event(actor, channelId, input), adaptiveRouting: null };
    const participants = action.type === 'configure' ? action.contract.participants : action.type === 'staff' ? action.participants : null;
    if (room && room.coordinatorId !== actor.id) throw new HiveError(403, 'Only this room coordinator changes the room');
    const coordination = event(actor, 'room', input.requestId, { kind: participants ? 'delegation_attempt' : 'room_event',
      channelId, summary: `room ${action.type}`, usesRoom: participants ? true : undefined, executionId });
    let policy: AdaptiveAgentPolicy | null = null;
    if (participants) {
      policy = await deps.adaptiveTopology.beforeBrainAction(actor, coordination);
      authenticate(deps, actor, token);
      if (policy) {
        if (participants.length > policy.workerBudget) throw new HiveError(409, 'Room participants exceed the applied worker budget');
        const available = readAdaptiveCapacity(deps, { projectId: actor.projectId!, executionId: policy.executionId }).workers.available;
        if (participants.some(member => !available.some(worker => worker.name === member.name)))
          throw new HiveError(409, 'A room participant is not available for this execution');
      }
    }
    const result = deps.rooms.event(actor, channelId, input);
    if (participants) return { ...result, adaptiveRouting: policy };
    return { ...result, ...await afterCommit(deps, actor, coordination) };
  });
}

export function setAdaptiveThreadStatus(deps: AdaptiveActionDeps, actor: Agent, threadId: string, status: ThreadStatus | null, token?: string) {
  return coordinateMutation(deps, actor, async defer => {
    authenticate(deps, actor, token);
    const root = deps.messageQueries.getMessageById(threadId);
    const before = deps.messageQueries.threadStatus(threadId);
    const thread = deps.messages.setThreadStatus(actor, threadId, status);
    if (before === status || actor.role !== 'brain') return { thread, adaptiveRouting: null } as { thread: typeof thread } & PostCommitRouting;
    const coordination = event(actor, 'thread-status', `${threadId}:${status}:${randomUUID()}`, {
      kind: 'task_event', channelId: root.channelId, summary: `thread status ${status}`,
      taskId: deps.tasks.has(threadId) ? threadId : undefined, threadId,
    });
    const routing = await afterCommit(deps, actor, coordination);
    deferCapacityChange(deps, actor, defer, coordination.eventId!, routing.adaptiveRouting?.executionId);
    return { thread, ...routing };
  });
}
