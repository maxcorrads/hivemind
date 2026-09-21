import { randomUUID } from 'node:crypto';
import { Hive, parseMentions } from './hive.ts';
import { HiveError, type Agent, type ThreadStatus } from '../shared/types.ts';
import { validated, sendInputSchema } from '../shared/api-contract.ts';
import { assignTaskSchema, taskEventSchema } from '../shared/tasks.ts';
import { roomEventSchema } from '../shared/rooms.ts';
import {
  bindAdaptiveMessage, clearAdaptivePermit, coordinateMutation, coordinationEventId, permitAdaptiveTask,
} from './adaptive-topology-admission.ts';
import type { AdaptiveCoordinationEvent } from './adaptive-topology.ts';

function event(actor: Agent, family: string, requestId: string,
  rest: Omit<AdaptiveCoordinationEvent, 'actorId' | 'actorRole' | 'eventId'>): AdaptiveCoordinationEvent {
  if (actor.role !== 'brain' && actor.role !== 'worker') throw new HiveError(403, 'Only agents coordinate work');
  return { ...rest, actorId: actor.id, actorRole: actor.role, eventId: coordinationEventId(actor.id, family, requestId) };
}
function taskRetry(hive: Hive, actor: Agent, requestId: string): boolean {
  return Boolean(hive.db.prepare('SELECT 1 FROM task_events WHERE actor_id=? AND request_id=?').get(actor.id, requestId) ||
    hive.db.prepare('SELECT 1 FROM task_request_aliases WHERE actor_id=? AND request_id=?').get(actor.id, requestId));
}
function reauthorize(hive: Hive, actor: Agent, before: unknown): void {
  if (hive.db.prepare('SELECT token_hash FROM agents WHERE id=?').get(actor.id)?.token_hash !== before)
    throw new HiveError(401, 'Credentials changed while revalidating coordination');
}

export function sendAdaptiveAgentMessage(hive: Hive, actor: Agent, channelRef: string, raw: unknown) {
  const input = validated(sendInputSchema, raw);
  return coordinateMutation(hive, actor, async () => {
    const channel = hive.getChannel(channelRef, actor.projectId);
    if (!hive.canSeeChannel(actor, channel) || !hive.canPost(actor, channel)) throw new HiveError(403, 'Cannot send to this channel');
    const body = input.body ?? '';
    const requestId = input.requestId ?? randomUUID();
    const messageInput = { ...input, body, channel: channel.id, requestId };
    if (hive.hasActiveSendRequest(actor, channel.id, requestId)) {
      const message = hive.postMessage(actor, messageInput);
      return { ok: true, seq: message.seq, id: message.id, adaptiveRouting: hive.adaptiveTopology.forAgent(actor) };
    }
    if (input.threadId) {
      const root = hive.getMessageById(input.threadId);
      if (root.channelId !== channel.id) throw new HiveError(400, 'Thread is not in this channel');
    }
    const roster = hive.listAgents(actor);
    const directed = new Set([
      ...parseMentions(body, roster),
      ...(input.recipients ?? []).map(name => hive.getAgentByName(name)?.id).filter((id): id is string => Boolean(id)),
      ...(channel.type === 'dm' ? channel.memberIds : []),
    ]);
    const targets = roster.filter(a => a.role === 'worker' && directed.has(a.id));
    const room = hive.rooms.peek(channel.id);
    if (actor.role === 'brain' && room && directed.size === 0 && input.eventType === 'assignment') {
      for (const id of room.participantIds) {
        const worker = roster.find(a => a.id === id);
        if (worker) targets.push(worker);
      }
    }
    const newWork = actor.role === 'brain' && targets.length > 0 &&
      (input.eventType === 'assignment' || (!input.threadId && !['progress', 'acknowledgement', 'decision'].includes(input.eventType ?? '')));
    const coordination = event(actor, 'message', requestId, {
      kind: newWork ? 'delegation_attempt' : actor.role === 'brain' ? 'brain_message' : 'worker_message',
      channelId: channel.id,
      taskId: input.threadId && hive.tasks.has(input.threadId) ? input.threadId : undefined,
      summary: body, eventType: input.eventType,
      workerName: newWork && targets.length === 1 ? targets[0]!.name : undefined,
      usesRoom: newWork ? Boolean(room) : undefined,
    });
    let policy = null;
    const credential = hive.db.prepare('SELECT token_hash FROM agents WHERE id=?').get(actor.id)?.token_hash;
    if (actor.role === 'brain') policy = await hive.adaptiveTopology.beforeBrainAction(actor, coordination);
    reauthorize(hive, actor, credential);
    const message = hive.postMessage(actor, messageInput, newWork
      ? posted => bindAdaptiveMessage(hive, actor, posted, targets.map(worker => worker.id), policy)
      : undefined);
    if (actor.role === 'worker' && input.eventType !== 'acknowledgement')
      policy = await hive.adaptiveTopology.afterAgentAction(actor, coordination);
    return { ok: true, seq: message.seq, id: message.id, adaptiveRouting: policy };
  });
}

export function assignAdaptiveTask(hive: Hive, actor: Agent, raw: unknown) {
  if (actor.role !== 'brain') throw new HiveError(403, 'Only a brain assigns work');
  const input = validated(assignTaskSchema, raw);
  return coordinateMutation(hive, actor, async () => {
    if (taskRetry(hive, actor, input.requestId)) return { ...hive.tasks.assign(actor, input), adaptiveRouting: hive.adaptiveTopology.forAgent(actor) };
    const coordination = event(actor, 'task', input.requestId, { kind: 'delegation_attempt',
      channelId: input.channel, summary: input.contract.objective, workerName: input.worker, usesRoom: Boolean(input.room) });
    const policy = await hive.adaptiveTopology.beforeBrainAction(actor, coordination);
    permitAdaptiveTask(hive, actor, input, policy);
    try {
      // TaskStore checks capacity/permit and links the task inside its existing transaction.
      const result = hive.tasks.assign(actor, input);
      return { ...result, adaptiveRouting: hive.adaptiveTopology.forAgent(actor) };
    } finally { clearAdaptivePermit(hive, actor.id); }
  });
}

export function mutateAdaptiveTask(hive: Hive, actor: Agent, taskId: string, raw: unknown) {
  const input = validated(taskEventSchema, raw);
  return coordinateMutation(hive, actor, async () => {
    const task = hive.tasks.get(actor, taskId);
    if (actor.id !== task.assignerId && actor.id !== task.workerId) throw new HiveError(403, 'Only task participants may mutate this task');
    if (taskRetry(hive, actor, input.requestId)) return { ...hive.tasks.event(actor, taskId, input), adaptiveRouting: hive.adaptiveTopology.forAgent(actor) };
    const revise = input.action.type === 'revise';
    const coordination = event(actor, 'task', input.requestId, {
      kind: revise ? 'delegation_attempt' : 'task_event', channelId: task.channelId, taskId,
      eventType: input.action.type, summary: input.action.type,
      ...(revise ? { workerName: input.action.worker, summary: input.action.contract.objective, usesRoom: Boolean(task.room) } : {}),
    });
    let policy = null;
    if (revise) {
      if (actor.id !== task.assignerId || actor.role !== 'brain') throw new HiveError(403, 'Only the assigning brain revises work');
      policy = await hive.adaptiveTopology.beforeBrainAction(actor, coordination);
      permitAdaptiveTask(hive, actor, { requestId: input.requestId, worker: input.action.worker,
        channel: task.channelId, contract: input.action.contract }, policy);
    }
    try {
      const result = hive.tasks.event(actor, taskId, input);
      // Completion/review is classified AFTER the mutation so it can release a pending downgrade immediately.
      if (!revise) policy = await hive.adaptiveTopology.afterAgentAction(actor, coordination);
      await hive.adaptiveTopology.capacityChanged(actor, input.requestId, policy?.executionId);
      return { ...result, adaptiveRouting: policy };
    } finally { clearAdaptivePermit(hive, actor.id); }
  });
}

export function mutateAdaptiveRoom(hive: Hive, actor: Agent, channelId: string, raw: unknown) {
  const input = validated(roomEventSchema, raw);
  return coordinateMutation(hive, actor, async () => {
    const room = hive.rooms.view(actor, channelId).room;
    if (hive.db.prepare('SELECT 1 FROM room_events WHERE actor_id=? AND request_id=?').get(actor.id, input.requestId))
      return { ...hive.rooms.event(actor, channelId, input), adaptiveRouting: hive.adaptiveTopology.forAgent(actor) };
    const staffing = input.action.type === 'configure' || input.action.type === 'staff';
    if (actor.role === 'brain' && room && room.coordinatorId !== actor.id) throw new HiveError(403, 'Only this room coordinator changes the room');
    const coordination = event(actor, 'room', input.requestId, { kind: staffing ? 'delegation_attempt' : 'room_event',
      channelId, summary: `room ${input.action.type}`, usesRoom: staffing ? true : undefined });
    let policy = null;
    if (staffing && actor.role === 'brain') {
      policy = await hive.adaptiveTopology.beforeBrainAction(actor, coordination);
      const participants = input.action.type === 'configure' ? input.action.contract.participants : input.action.participants;
      if (policy && participants.length > policy.workerBudget) throw new HiveError(409, 'Room participants exceed the applied worker budget');
    }
    const result = hive.rooms.event(actor, channelId, input);
    if (!staffing) policy = await hive.adaptiveTopology.afterAgentAction(actor, coordination);
    return { ...result, adaptiveRouting: policy };
  });
}

export function setAdaptiveThreadStatus(hive: Hive, actor: Agent, threadId: string, status: ThreadStatus | null) {
  return coordinateMutation(hive, actor, async () => {
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
