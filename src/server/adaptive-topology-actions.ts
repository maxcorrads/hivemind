import { createHash, randomUUID } from 'node:crypto';
import { Hive, parseMentions } from './hive.ts';
import { HiveError, type Agent, type ThreadStatus } from '../shared/types.ts';
import { validated, sendInputSchema } from '../shared/api-contract.ts';
import { assignTaskSchema, taskEventSchema } from '../shared/tasks.ts';
import { roomEventSchema } from '../shared/rooms.ts';
import { bindAdaptiveMessage, clearAdaptivePermit, coordinateMutation, coordinationEventId, permitAdaptiveTask } from './adaptive-topology-admission.ts';
import type { AdaptiveAgentPolicy, AdaptiveCoordinationEvent } from './adaptive-topology.ts';

function event(actor: Agent, family: string, requestId: string,
  rest: Omit<AdaptiveCoordinationEvent, 'actorId' | 'actorRole' | 'eventId'>): AdaptiveCoordinationEvent {
  if (actor.role !== 'brain' && actor.role !== 'worker') throw new HiveError(403, 'Only agents coordinate work');
  const payload = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  return { ...rest, actorId: actor.id, actorRole: actor.role,
    eventId: coordinationEventId(actor.id, family, `${requestId}:${payload}`) };
}
function taskRetry(hive: Hive, actor: Agent, requestId: string): boolean {
  return Boolean(hive.db.prepare('SELECT 1 FROM task_events WHERE actor_id=? AND request_id=?').get(actor.id, requestId) ||
    hive.db.prepare('SELECT 1 FROM task_request_aliases WHERE actor_id=? AND request_id=?').get(actor.id, requestId));
}
function authenticate(hive: Hive, actor: Agent, token?: string): void {
  if (token !== undefined && hive.agentByToken(token).id !== actor.id) throw new HiveError(401, 'Authenticated identity changed');
}
function reauthorize(hive: Hive, actor: Agent, before: unknown, token?: string): void {
  authenticate(hive, actor, token);
  if (hive.db.prepare('SELECT token_hash FROM agents WHERE id=?').get(actor.id)?.token_hash !== before)
    throw new HiveError(401, 'Credentials changed while revalidating coordination');
}

export function sendAdaptiveAgentMessage(hive: Hive, actor: Agent, channelRef: string, raw: unknown, token?: string) {
  const input = validated(sendInputSchema, raw);
  return coordinateMutation(hive, actor, async () => {
    authenticate(hive, actor, token);
    const channel = hive.getChannel(channelRef, actor.projectId);
    if (!hive.canSeeChannel(actor, channel) || !hive.canPost(actor, channel)) throw new HiveError(403, 'Cannot send to this channel');
    const body = input.body ?? '', requestId = input.requestId ?? randomUUID();
    const messageInput = { ...input, body, channel: channel.id, requestId };
    if (hive.hasActiveSendRequest(actor, channel.id, requestId)) {
      const message = hive.postMessage(actor, messageInput);
      return { ok: true, seq: message.seq, id: message.id, adaptiveRouting: hive.adaptiveTopology.forAgent(actor) };
    }
    if (!body.trim() && !input.attachmentIds?.length) throw new HiveError(400, 'Empty message');
    if (input.threadId && hive.getMessageById(input.threadId).channelId !== channel.id)
      throw new HiveError(400, 'Thread is not in this channel');
    const roster = hive.listAgents(actor);
    const directed = new Set([
      ...parseMentions(body, roster),
      ...(input.recipients ?? []).map(name => hive.getAgentByName(name)?.id).filter((id): id is string => Boolean(id)),
      ...(channel.type === 'dm' ? channel.memberIds : []),
    ]);
    const targets = roster.filter(a => a.role === 'worker' && directed.has(a.id));
    const room = hive.rooms.peek(channel.id);
    if (actor.role === 'brain' && room && directed.size === 0 && input.eventType === 'assignment') {
      for (const id of room.participantIds) { const worker = roster.find(a => a.id === id); if (worker) targets.push(worker); }
    }
    const newWork = actor.role === 'brain' && targets.length > 0 &&
      (input.eventType === 'assignment' || (!input.threadId && !['progress','acknowledgement','decision'].includes(input.eventType ?? '')));
    const coordination = event(actor, 'message', requestId, {
      kind: newWork ? 'delegation_attempt' : actor.role === 'brain' ? 'brain_message' : 'worker_message',
      channelId: channel.id, taskId: input.threadId && hive.tasks.has(input.threadId) ? input.threadId : undefined,
      summary: body, eventType: input.eventType,
      workerName: newWork && targets.length === 1 ? targets[0]!.name : undefined,
      usesRoom: newWork ? Boolean(room) : undefined,
    });
    let policy: AdaptiveAgentPolicy | null = null;
    const credential = hive.db.prepare('SELECT token_hash FROM agents WHERE id=?').get(actor.id)?.token_hash;
    if (actor.role === 'brain') policy = await hive.adaptiveTopology.beforeBrainAction(actor, coordination);
    reauthorize(hive, actor, credential, token);
    const message = hive.postMessage(actor, messageInput, newWork
      ? posted => bindAdaptiveMessage(hive, actor, posted, targets.map(worker => worker.id), policy) : undefined);
    if (actor.role === 'worker' && input.eventType !== 'acknowledgement')
      policy = await hive.adaptiveTopology.afterAgentAction(actor, coordination);
    return { ok: true, seq: message.seq, id: message.id, adaptiveRouting: policy };
  });
}

export function assignAdaptiveTask(hive: Hive, actor: Agent, raw: unknown, token?: string) {
  if (actor.role !== 'brain') throw new HiveError(403, 'Only a brain assigns work');
  const input = validated(assignTaskSchema, raw);
  return coordinateMutation(hive, actor, async () => {
    authenticate(hive, actor, token);
    if (taskRetry(hive, actor, input.requestId)) return { ...hive.tasks.assign(actor, input), adaptiveRouting: hive.adaptiveTopology.forAgent(actor) };
    const coordination = event(actor, 'task', input.requestId, { kind: 'delegation_attempt',
      channelId: input.channel, summary: input.contract.objective, workerName: input.worker, usesRoom: Boolean(input.room) });
    const policy = await hive.adaptiveTopology.beforeBrainAction(actor, coordination);
    authenticate(hive, actor, token);
    permitAdaptiveTask(hive, actor, input, policy);
    try {
      const result = hive.tasks.assign(actor, input);
      await hive.adaptiveTopology.capacityChanged(actor, input.requestId, policy?.executionId);
      return { ...result, adaptiveRouting: hive.adaptiveTopology.forAgent(actor) };
    } finally { clearAdaptivePermit(hive, actor.id); }
  });
}

export function mutateAdaptiveTask(hive: Hive, actor: Agent, taskId: string, raw: unknown, token?: string) {
  const input = validated(taskEventSchema, raw), action = input.action;
  return coordinateMutation(hive, actor, async () => {
    authenticate(hive, actor, token);
    const task = hive.tasks.get(actor, taskId);
    if (actor.id !== task.assignerId && actor.id !== task.workerId) throw new HiveError(403, 'Only task participants may mutate this task');
    if (taskRetry(hive, actor, input.requestId)) return { ...hive.tasks.event(actor, taskId, input), adaptiveRouting: hive.adaptiveTopology.forAgent(actor) };
    const coordination = event(actor, 'task', input.requestId, {
      kind: action.type === 'revise' ? 'delegation_attempt' : 'task_event', channelId: task.channelId, taskId,
      eventType: action.type, summary: action.type === 'revise' ? action.contract.objective : action.type,
      workerName: action.type === 'revise' ? action.worker : undefined,
      usesRoom: action.type === 'revise' ? Boolean(task.room) : undefined,
    });
    let policy: AdaptiveAgentPolicy | null = null;
    if (action.type === 'revise') {
      if (actor.id !== task.assignerId || actor.role !== 'brain') throw new HiveError(403, 'Only the assigning brain revises work');
      policy = await hive.adaptiveTopology.beforeBrainAction(actor, coordination);
      authenticate(hive, actor, token);
      permitAdaptiveTask(hive, actor, { requestId: input.requestId, worker: action.worker,
        channel: task.channelId, contract: action.contract }, policy);
    }
    try {
      const result = hive.tasks.event(actor, taskId, input);
      // The safe checkpoint must observe the newly committed result/review, not its preceding state.
      if (action.type !== 'revise') policy = await hive.adaptiveTopology.afterAgentAction(actor, coordination);
      await hive.adaptiveTopology.capacityChanged(actor, input.requestId, policy?.executionId);
      return { ...result, adaptiveRouting: policy };
    } finally { clearAdaptivePermit(hive, actor.id); }
  });
}

export function mutateAdaptiveRoom(hive: Hive, actor: Agent, channelId: string, raw: unknown, token?: string) {
  const input = validated(roomEventSchema, raw), action = input.action;
  return coordinateMutation(hive, actor, async () => {
    authenticate(hive, actor, token);
    const room = hive.rooms.view(actor, channelId).room;
    if (hive.db.prepare('SELECT 1 FROM room_events WHERE actor_id=? AND request_id=?').get(actor.id, input.requestId))
      return { ...hive.rooms.event(actor, channelId, input), adaptiveRouting: hive.adaptiveTopology.forAgent(actor) };
    const participants = action.type === 'configure' ? action.contract.participants : action.type === 'staff' ? action.participants : null;
    if (actor.role === 'brain' && room && room.coordinatorId !== actor.id) throw new HiveError(403, 'Only this room coordinator changes the room');
    const coordination = event(actor, 'room', input.requestId, { kind: participants ? 'delegation_attempt' : 'room_event',
      channelId, summary: `room ${action.type}`, usesRoom: participants ? true : undefined });
    let policy: AdaptiveAgentPolicy | null = null;
    if (participants && actor.role === 'brain') {
      policy = await hive.adaptiveTopology.beforeBrainAction(actor, coordination);
      authenticate(hive, actor, token);
      if (policy && participants.length > policy.workerBudget) throw new HiveError(409, 'Room participants exceed the applied worker budget');
    }
    const result = hive.rooms.event(actor, channelId, input);
    if (!participants) policy = await hive.adaptiveTopology.afterAgentAction(actor, coordination);
    return { ...result, adaptiveRouting: policy };
  });
}

export function setAdaptiveThreadStatus(hive: Hive, actor: Agent, threadId: string, status: ThreadStatus | null, token?: string) {
  return coordinateMutation(hive, actor, async () => {
    authenticate(hive, actor, token);
    const root = hive.getMessageById(threadId);
    const before = hive.db.prepare('SELECT status FROM threads WHERE id=?').get(threadId)?.status;
    const thread = hive.setThreadStatus(actor, threadId, status);
    if (before !== status && (actor.role === 'brain' || actor.role === 'worker')) {
      const coordination = event(actor, 'thread-status', `${threadId}:${status}:${randomUUID()}`, {
        kind: 'task_event', channelId: root.channelId, summary: `thread status ${status}`,
        taskId: hive.tasks.has(threadId) ? threadId : undefined,
      });
      const policy = await hive.adaptiveTopology.afterAgentAction(actor, coordination);
      await hive.adaptiveTopology.capacityChanged(actor, coordination.eventId!, policy?.executionId);
    }
    return thread;
  });
}
