import { createHash, randomUUID } from 'node:crypto';
import { Hive, parseMentions } from './hive.ts';
import { HiveError, type Agent, type ThreadStatus } from '../shared/types.ts';
import { validated, sendInputSchema } from '../shared/api-contract.ts';
import { assignTaskSchema, taskEventSchema } from '../shared/tasks.ts';
import { roomEventSchema } from '../shared/rooms.ts';
import { bindAdaptiveMessage, clearAdaptivePermit, coordinateMutation, coordinationEventId, permitAdaptiveTask } from './adaptive-topology-admission.ts';
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
  const { executionId, ...input } = validated(sendInputSchema, raw);
  return coordinateMutation(hive, actor, async () => {
    authenticate(hive, actor, token);
    const channel = hive.getChannel(channelRef, actor.projectId);
    if (!hive.canSeeChannel(actor, channel) || !hive.canPost(actor, channel)) throw new HiveError(403, 'Cannot send to this channel');
    const body = input.body ?? '', requestId = input.requestId ?? randomUUID();
    const messageInput = { ...input, body, channel: channel.id, requestId };
    if (hive.hasActiveSendRequest(actor, channel.id, requestId)) {
      const message = hive.postMessage(actor, messageInput);
      return { ok: true, seq: message.seq, id: message.id, adaptiveRouting: hive.adaptiveTopology.forAgent(actor, executionId) };
    }
    if (!body.trim() && !input.attachmentIds?.length) throw new HiveError(400, 'Empty message');
    if (input.threadId && hive.getMessageById(input.threadId).channelId !== channel.id)
      throw new HiveError(400, 'Thread is not in this channel');
    if (actor.role !== 'brain') {
      if (executionId) throw new HiveError(400, 'Only a brain declares an adaptive executionId');
      const message = hive.postMessage(actor, messageInput);
      return { ok: true, seq: message.seq, id: message.id };
    }
    const roster = hive.listAgents(actor);
    const directed = new Set([
      ...parseMentions(body, roster),
      ...(input.recipients ?? []).map(name => hive.getAgentByName(name)?.id).filter((id): id is string => Boolean(id)),
      ...(channel.type === 'dm' ? channel.memberIds : []),
    ]);
    const targets = roster.filter(a => a.role === 'worker' && directed.has(a.id));
    const room = hive.rooms.peek(channel.id);
    if (room && directed.size === 0) {
      for (const id of room.participantIds) { const worker = roster.find(a => a.id === id); if (worker) targets.push(worker); }
    }
    // Sender-declared progress/decision labels are not authority to contact a new worker.
    // Only a known, still-open assignment thread of one active execution continues without admitting new work.
    const bound = input.threadId && targets.length && hive.adaptiveTopology.hasActive(actor) &&
      hive.db.prepare('SELECT status FROM threads WHERE id=?').get(input.threadId)?.status !== 'done'
      ? new Set(targets.map(worker => {
        const row = hive.db.prepare(`SELECT execution_id FROM adaptive_topology_messages WHERE root_id=? AND worker_id=?`).get(input.threadId!, worker.id) ??
          hive.db.prepare(`SELECT a.execution_id FROM adaptive_topology_tasks a JOIN task_records t ON t.id=a.task_id
            WHERE a.task_id=? AND t.worker_id=? AND json_extract(t.snapshot,'$.state') NOT IN ('accepted_complete','rejected')`)
            .get(input.threadId!, worker.id);
        return row ? String(row.execution_id) : null;
      })) : null;
    const threadExecution = bound?.size === 1 ? [...bound][0] : null;
    const continuing = Boolean(threadExecution && hive.adaptiveTopology.forAgent(actor, threadExecution) &&
      (!executionId || executionId === threadExecution));
    const inertAcknowledgement = input.eventType === 'acknowledgement' && !input.attachmentIds?.length;
    const newWork = !inertAcknowledgement && (input.eventType === 'assignment' || (targets.length > 0 && !continuing));
    const coordination = event(actor, 'message', requestId, {
      kind: newWork ? 'delegation_attempt' : 'brain_message',
      channelId: channel.id, taskId: input.threadId && hive.tasks.has(input.threadId) ? input.threadId : undefined,
      threadId: input.threadId ?? undefined, summary: body, eventType: input.eventType,
      workerName: newWork && targets.length === 1 ? targets[0]!.name : undefined,
      usesRoom: newWork ? Boolean(room) : undefined,
      // Continuing a known thread may be attributed implicitly; new delegation must name its execution.
      executionId: executionId ?? (continuing && !newWork ? threadExecution! : undefined),
    });
    const credential = hive.db.prepare('SELECT token_hash FROM agents WHERE id=?').get(actor.id)?.token_hash;
    const policy = await hive.adaptiveTopology.beforeBrainAction(actor, coordination);
    reauthorize(hive, actor, credential, token);
    const message = hive.postMessage(actor, messageInput, newWork
      ? posted => bindAdaptiveMessage(hive, actor, posted, targets.map(worker => worker.id), policy) : undefined);
    return { ok: true, seq: message.seq, id: message.id, adaptiveRouting: policy };
  });
}

export function assignAdaptiveTask(hive: Hive, actor: Agent, raw: unknown, token?: string) {
  if (actor.role !== 'brain') throw new HiveError(403, 'Only a brain assigns work');
  const { executionId, ...input } = validated(assignTaskSchema, raw);
  return coordinateMutation(hive, actor, async () => {
    authenticate(hive, actor, token);
    if (taskRetry(hive, actor, input.requestId)) return { ...hive.tasks.assign(actor, input), adaptiveRouting: hive.adaptiveTopology.forAgent(actor, executionId) };
    const coordination = event(actor, 'task', input.requestId, { kind: 'delegation_attempt', executionId,
      channelId: input.channel, summary: input.contract.objective, workerName: input.worker, usesRoom: Boolean(input.room) });
    const policy = await hive.adaptiveTopology.beforeBrainAction(actor, coordination);
    authenticate(hive, actor, token);
    permitAdaptiveTask(hive, actor, input, policy);
    try {
      const result = hive.tasks.assign(actor, input);
      await hive.adaptiveTopology.capacityChanged(actor, input.requestId, policy?.executionId);
      return { ...result, adaptiveRouting: policy ? hive.adaptiveTopology.forAgent(actor, policy.executionId) : null };
    } finally { clearAdaptivePermit(hive, actor.id); }
  });
}

export function mutateAdaptiveTask(hive: Hive, actor: Agent, taskId: string, raw: unknown, token?: string) {
  const { executionId, ...input } = validated(taskEventSchema, raw), action = input.action;
  return coordinateMutation(hive, actor, async () => {
    authenticate(hive, actor, token);
    const task = hive.tasks.get(actor, taskId);
    // TaskStore owns claim permissions and revision conflicts; routing must not replace a 409 with its own 403.
    // Workers never drive Jev; only the assigning brain's lifecycle actions are evaluated.
    const coordinating = actor.role === 'brain' && actor.id === task.assignerId;
    if (actor.role !== 'brain' && executionId) throw new HiveError(400, 'Only a brain declares an adaptive executionId');
    if (taskRetry(hive, actor, input.requestId)) return { ...hive.tasks.event(actor, taskId, input), adaptiveRouting: hive.adaptiveTopology.forAgent(actor, executionId) };
    let policy: AdaptiveAgentPolicy | null = null;
    const coordination = coordinating ? event(actor, 'task', input.requestId, {
      kind: action.type === 'revise' ? 'delegation_attempt' : 'task_event', channelId: task.channelId, taskId, threadId: taskId,
      eventType: action.type, summary: action.type === 'revise' ? action.contract.objective : action.type,
      workerName: action.type === 'revise' ? action.worker : undefined,
      usesRoom: action.type === 'revise' ? Boolean(task.room) : undefined, executionId,
    }) : null;
    if (action.type === 'revise') {
      if (actor.id !== task.assignerId || actor.role !== 'brain') throw new HiveError(403, 'Only the assigning brain revises work');
      policy = await hive.adaptiveTopology.beforeBrainAction(actor, coordination!);
      authenticate(hive, actor, token);
      permitAdaptiveTask(hive, actor, { requestId: input.requestId, worker: action.worker,
        channel: task.channelId, contract: action.contract }, policy);
    }
    try {
      const result = hive.tasks.event(actor, taskId, input);
      // The brain's review is evaluated after the mutation reaches its safe checkpoint.
      if (coordination && action.type !== 'revise') policy = await hive.adaptiveTopology.afterAgentAction(actor, coordination);
      await hive.adaptiveTopology.capacityChanged(actor, input.requestId, policy?.executionId);
      return { ...result, adaptiveRouting: policy };
    } finally { clearAdaptivePermit(hive, actor.id); }
  });
}

export function mutateAdaptiveRoom(hive: Hive, actor: Agent, channelId: string, raw: unknown, token?: string) {
  const { executionId, ...input } = validated(roomEventSchema, raw), action = input.action;
  return coordinateMutation(hive, actor, async () => {
    authenticate(hive, actor, token);
    const room = hive.rooms.view(actor, channelId).room;
    if (actor.role !== 'brain' && executionId) throw new HiveError(400, 'Only a brain declares an adaptive executionId');
    if (hive.db.prepare('SELECT 1 FROM room_events WHERE actor_id=? AND request_id=?').get(actor.id, input.requestId))
      return { ...hive.rooms.event(actor, channelId, input), adaptiveRouting: hive.adaptiveTopology.forAgent(actor, executionId) };
    if (actor.role !== 'brain') return { ...hive.rooms.event(actor, channelId, input), adaptiveRouting: null };
    const participants = action.type === 'configure' ? action.contract.participants : action.type === 'staff' ? action.participants : null;
    if (room && room.coordinatorId !== actor.id) throw new HiveError(403, 'Only this room coordinator changes the room');
    const coordination = event(actor, 'room', input.requestId, { kind: participants ? 'delegation_attempt' : 'room_event',
      channelId, summary: `room ${action.type}`, usesRoom: participants ? true : undefined, executionId });
    let policy: AdaptiveAgentPolicy | null = null;
    if (participants) {
      policy = await hive.adaptiveTopology.beforeBrainAction(actor, coordination);
      authenticate(hive, actor, token);
      if (policy) {
        if (participants.length > policy.workerBudget) throw new HiveError(409, 'Room participants exceed the applied worker budget');
        const available = readAdaptiveCapacity(hive, { projectId: actor.projectId!, executionId: policy.executionId }).workers.available;
        if (participants.some(member => !available.some(worker => worker.name === member.name)))
          throw new HiveError(409, 'A room participant is not available for this execution');
      }
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
    if (before !== status && actor.role === 'brain') {
      const coordination = event(actor, 'thread-status', `${threadId}:${status}:${randomUUID()}`, {
        kind: 'task_event', channelId: root.channelId, summary: `thread status ${status}`,
        taskId: hive.tasks.has(threadId) ? threadId : undefined, threadId,
      });
      const policy = await hive.adaptiveTopology.afterAgentAction(actor, coordination);
      await hive.adaptiveTopology.capacityChanged(actor, coordination.eventId!, policy?.executionId);
    }
    return thread;
  });
}
