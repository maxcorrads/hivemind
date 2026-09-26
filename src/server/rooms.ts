import { createHash, randomUUID } from 'node:crypto';
import type { RoomStoreDeps } from './services/ports.ts';
import { HiveError, type Agent, type Channel, type Message } from '../shared/types.ts';
import { roomEventSchema, sourceLinkSchema, sourceReportSchema, type Room, type RoomTask, type RoomView, type SourceLink } from '../shared/rooms.ts';
import type { TaskSnapshot } from '../shared/tasks.ts';

type TaskLink = { task_id: string; channel_id: string; version: number; action_key: string; payload_hash: string; status: 'active' | 'stop_requested' | 'stopped' };
const finished = (t: TaskSnapshot) => ['accepted_complete', 'rejected', 'cancelled'].includes(t.state);
export class RoomStore {
  constructor(private readonly deps: RoomStoreDeps) {}
  private get db() { return this.deps.storage.db; }
  private hash(v: unknown) { return createHash('sha256').update(JSON.stringify(v)).digest('hex'); }
  peek(channel: string): Room | null {
    const row = this.db.prepare('SELECT snapshot FROM rooms WHERE channel_id=?').get(channel);
    return row ? JSON.parse(String(row.snapshot)) : null;
  }
  /** Sidebar projection only: retain channels and their history in every other view. */
  archivedChannelIds(visibleChannels: readonly Channel[]): string[] {
    const visible = new Set(visibleChannels.map(channel => channel.id));
    return this.db.prepare("SELECT channel_id FROM rooms WHERE json_extract(snapshot,'$.state')='archived' ORDER BY channel_id")
      .all().map(row => String(row.channel_id)).filter(id => visible.has(id));
  }
  /** Carries the archive state so clients update navigation without refetching the snapshot. */
  private roomChanged(channelId: string) {
    this.deps.bus.emit('room', { channelId, archived: this.peek(channelId)?.state === 'archived' });
  }
  private channel(actor: Agent, channel: string) {
    const ch = this.deps.channels.getChannel(channel, actor.projectId);
    if (!this.deps.channels.canSeeChannel(actor, ch)) throw new HiveError(403, 'Cannot access this room');
    return ch;
  }
  private tasks(channel: string, before = '~'): TaskSnapshot[] {
    return this.db.prepare('SELECT t.snapshot,t.received_at FROM task_records t JOIN room_tasks r ON r.task_id=t.id WHERE t.channel_id=? AND t.id<? ORDER BY t.id DESC LIMIT 101').all(channel, before).map(r => {
      const task = JSON.parse(String(r.snapshot)) as TaskSnapshot;
      return { ...task, receivedAt: r.received_at as number | null, state: task.state === 'sent' && r.received_at !== null ? 'delivered' : task.state };
    });
  }
  private running(channel: string): TaskSnapshot[] {
    return this.db.prepare(`SELECT t.snapshot FROM task_records t LEFT JOIN room_tasks r ON r.task_id=t.id
      WHERE t.channel_id=? AND json_extract(t.snapshot,'$.state') NOT IN ('accepted_complete','rejected','cancelled')
      AND COALESCE(r.status,'active')!='stopped'`).all(channel).map(r => JSON.parse(String(r.snapshot)));
  }
  private links(channel: string): SourceLink[] {
    return this.db.prepare('SELECT snapshot FROM source_links WHERE channel_id=? ORDER BY bot_id,id').all(channel).map(r => JSON.parse(String(r.snapshot)));
  }
  view(actor: Agent, channel: string, beforeTask = '~'): RoomView {
    if (actor.role === 'bot') throw new HiveError(403, 'Bots only read their own source links');
    if (beforeTask !== '~' && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(beforeTask)) throw new HiveError(400, 'beforeTask must be a task UUID');
    const ch = this.channel(actor, channel), links = this.links(ch.id);
    const tasks = this.tasks(ch.id, beforeTask), hasMore = tasks.length > 100;
    return { room: this.peek(ch.id), links, activeTaskCount: this.running(ch.id).length, tasksHasMore: hasMore, nextTaskCursor: hasMore ? tasks[99]!.id : null, tasks: tasks.slice(0, 100).flatMap(t => {
      const room = this.taskInfo(t); return room ? [{ id: t.id, worker: t.workerName, state: t.state, room }] : [];
    }), unmanagedBots: ch.memberIds.map(id => this.deps.identity.getAgent(id)).filter(a => a.role === 'bot' && !links.some(l => l.botId === a.id)).map(a => a.name) };
  }
  history(actor: Agent, channel: string, before = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(before) || before < 1) throw new HiveError(400, 'before must be a positive revision');
    const ch = this.channel(actor, channel);
    if (actor.role === 'bot') throw new HiveError(403, 'Bots cannot read contracts');
    return this.db.prepare('SELECT snapshot FROM room_events WHERE channel_id=? AND revision<? ORDER BY revision DESC LIMIT 20')
      .all(ch.id, before).map(r => JSON.parse(String(r.snapshot)) as Room);
  }
  private persist(room: Room) {
    this.db.prepare('INSERT INTO rooms(channel_id,snapshot) VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET snapshot=excluded.snapshot')
      .run(room.channelId, JSON.stringify(room));
  }
  private message(actor: Agent, channel: Channel, body: string, recipients: string[], threadId: string | null = null,
    eventType: 'decision' | 'acknowledgement' = 'decision') {
    if (body.length > 4000) throw new HiveError(400, 'Room message too large');
    const id = randomUUID(), targets = JSON.stringify([...new Set(recipients)].filter(t => this.deps.channels.canSeeChannel(this.deps.identity.getAgent(t), channel)));
    this.deps.messages.insertCoordinationMessage({ id, channelId: channel.id, threadId, authorId: actor.id, body, eventType,
      mentions: targets, recipients: targets, createdAt: Date.now() });
    return this.deps.messageQueries.getMessageById(id);
  }
  private instruction(actor: Agent, ch: Channel, seq: number | undefined, previous: number | null) {
    if (actor.role === 'human') return seq ?? previous;
    if (!seq) throw new HiveError(403, 'A Human instruction sequence is required for this change');
    const m = this.deps.messageQueries.getVisibleMessage(actor, seq);
    if (m.authorRole !== 'human' || m.kind !== 'chat' || this.deps.channels.getChannel(m.channelId).projectId !== ch.projectId)
      throw new HiveError(403, 'Reference a real Human message in this project, not bot or quoted authority');
    if (previous !== null && seq <= previous) throw new HiveError(409, 'Use a new Human instruction for a new scope/lifecycle change');
    return seq;
  }
  event(actor: Agent, channel: string, raw: unknown) {
    if (!['human', 'brain', 'worker'].includes(actor.role)) throw new HiveError(403, 'Bots cannot change rooms');
    const parsed = roomEventSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid room event: ' + parsed.error.message);
    const input = parsed.data, action = input.action, ch = this.channel(actor, channel);
    const hash = this.hash({ channel: ch.id, input }); const messages: Message[] = [];
    const duplicate = this.deps.storage.transaction(() => {
      const retry = this.db.prepare('SELECT * FROM room_events WHERE actor_id=? AND request_id=?').get(actor.id, input.requestId);
      if (retry) {
        if (retry.hash !== hash) throw new HiveError(409, 'Room requestId reused with different payload');
        return true;
      }
      let room = this.peek(ch.id);
      const previousCoordinator = room?.coordinatorId;
      if ((room?.revision ?? 0) !== input.expectedRevision) {
        let concurrentContractAck = false;
        if (action.type === 'acknowledge' && room && input.expectedRevision > 0 && input.expectedRevision < room.revision &&
          action.contractVersion === room.contractVersion) {
          const previous = this.db.prepare(
            "SELECT json_extract(snapshot,'$.contractVersion') AS contract_version FROM room_events WHERE channel_id=? AND revision=?",
          ).get(ch.id, input.expectedRevision) as { contract_version: number } | undefined;
          concurrentContractAck = previous?.contract_version === room.contractVersion;
        }
        if (!concurrentContractAck) throw new HiveError(409, 'Room changed; get_room and reconcile the current revision');
      }
      if (action.type === 'acknowledge' || action.type === 'stopped') {
        if (!room || !room.participantIds.includes(actor.id) || actor.role !== 'worker') throw new HiveError(403, 'Only a participating worker can acknowledge');
      } else if (actor.role !== 'human' && (actor.role !== 'brain' || (room && room.coordinatorId !== actor.id)))
        throw new HiveError(403, 'Only Human or this coordinating brain can manage the room');
      let instruction = room?.humanInstructionSeq ?? null;
      const finiteClosure = action.type === 'archive' && room?.contract.mode === 'finite' && room.summarySeq !== null && !this.running(ch.id).length;
      if (action.type === 'configure' || (action.type === 'archive' && !finiteClosure) || action.type === 'reopen')
        instruction = this.instruction(actor, ch, input.humanInstructionSeq, room?.authoritySeq ?? null);
      if (action.type === 'configure' || action.type === 'staff') {
        if (action.type === 'staff' && !room) throw new HiveError(404, 'Configure a Human-authorized room before selecting workers');
        const contract = action.type === 'configure' ? action.contract : { ...room!.contract, participants: action.participants };
        if (Buffer.byteLength(JSON.stringify(contract)) > 16000) throw new HiveError(400, 'Room contract exceeds 16 KiB; keep rules compact');
        if (!['private', 'public'].includes(ch.type) || (contract.mode === 'finite' && ch.type !== 'private'))
          throw new HiveError(400, 'Finite rooms require a private channel; ongoing contracts require public/private channels');
        if (room?.state === 'archived') throw new HiveError(409, 'Reopen before editing the contract');
        if (!room && this.running(ch.id).length) throw new HiveError(409, 'Finish existing tasks before installing a room contract');
        const brain = this.deps.identity.getAgentByName(contract.coordinator);
        if (!brain || brain.role !== 'brain' || brain.projectId !== ch.projectId || !this.deps.channels.canSeeChannel(brain, ch))
          throw new HiveError(400, 'Coordinator must be an invited brain in this project');
        if (actor.role === 'brain' && actor.id !== brain.id) throw new HiveError(403, 'Only Human changes the coordinator');
        if (room && room.coordinatorId !== brain.id && this.running(ch.id).length)
          throw new HiveError(409, 'Coordinator change requires no running tasks; existing task ownership is not transferred');
        const participants = contract.participants.map(p => {
          const a = this.deps.identity.getAgentByName(p.name);
          if (!a || a.role !== 'worker' || a.projectId !== ch.projectId || !this.deps.channels.canSeeChannel(a, ch))
            throw new HiveError(400, 'Each participant must be an invited worker in this project');
          return a.id;
        });
        if (new Set(participants).size !== participants.length) throw new HiveError(400, 'Duplicate room participants');
        if (contract.mode === 'finite' && !participants.length) throw new HiveError(400, 'Finite rooms require participants');
        if (this.running(ch.id).some(t => !participants.includes(t.workerId))) throw new HiveError(409, 'Cannot remove a worker with running work');
        if (room && (room.contract.mode !== contract.mode || room.contract.originTaskId !== contract.originTaskId))
          throw new HiveError(409, 'Room mode and originating task are immutable; create another room');
        if (contract.originTaskId) {
          const origin = this.deps.tasks.get(brain, contract.originTaskId);
          if ((!room && origin.assignerId !== brain.id) || origin.channelId === ch.id) throw new HiveError(403, 'Origin must be a task assigned by this brain outside the room');
        }
        room = { channelId: ch.id, revision: room?.revision ?? 0, contractVersion: (room?.contractVersion ?? 0) + 1,
          state: 'active', coordinatorId: brain.id, participantIds: participants, contract,
          updatedAt: 0, humanInstructionSeq: instruction, authoritySeq: room?.authoritySeq ?? 0,
          lastEventSeq: 0, summarySeq: null, archivedRunning: null };
      } else {
        if (!room) throw new HiveError(404, 'No room contract');
        if (action.type === 'archive') {
          if (room.state !== 'active') throw new HiveError(409, 'Already archived');
          const active = this.running(ch.id);
          if (active.length && !action.running) throw new HiveError(409, 'Running tasks exist: explicitly choose finish or stop');
          const newestTaskEvent = Number(this.db.prepare("SELECT COALESCE(MAX(json_extract(snapshot,'$.lastEventSeq')),0) AS n FROM task_records WHERE channel_id=?").get(ch.id)!.n);
          if (room.contract.mode === 'finite' && (!room.summarySeq || room.summarySeq < newestTaskEvent) && !active.length)
            throw new HiveError(409, 'Publish a result/decision summary to the originating task before archive');
          room.state = 'archived'; room.archivedRunning = action.running ?? 'finish';
          if (action.running === 'stop') for (const t of active)
            this.db.prepare("UPDATE room_tasks SET status='stop_requested' WHERE task_id=?").run(t.id);
          this.requestLinks(ch.id, 'paused');
        } else if (action.type === 'reopen') {
          if (room.state !== 'archived') throw new HiveError(409, 'Room is already active');
          room.state = 'active'; room.archivedRunning = null; room.contractVersion++; room.summarySeq = null;
          if (action.resumeSources) this.requestLinks(ch.id, 'running');
        } else if (action.type === 'acknowledge') {
          if (action.contractVersion !== room.contractVersion) throw new HiveError(409, 'Read the current room contract before acknowledging');
          this.db.prepare('INSERT INTO room_acks(channel_id,actor_id,version) VALUES(?,?,?) ON CONFLICT(channel_id,actor_id) DO UPDATE SET version=excluded.version')
            .run(ch.id, actor.id, action.contractVersion);
        } else if (action.type === 'reconcile' || action.type === 'stopped') {
          const t = this.deps.tasks.get(actor, action.taskId), info = this.taskInfo(t);
          if (t.channelId !== ch.id || !info || finished(t)) throw new HiveError(409, 'Select running work in this room');
          if (action.type === 'stopped') {
            if (t.workerId !== actor.id || info.status !== 'stop_requested') throw new HiveError(403, 'Only the assigned worker confirms a requested stop');
            this.db.prepare("UPDATE room_tasks SET status='stopped' WHERE task_id=?").run(t.id);
          } else {
            if (actor.role !== 'brain' || actor.id !== t.assignerId) throw new HiveError(403, 'Only the assigning coordinator reconciles tasks');
            if (info.status === 'stopped') throw new HiveError(409, 'Stopped work cannot be resumed implicitly; assign a new task');
            if (action.decision === 'continue' && room.state === 'archived' && room.archivedRunning !== 'finish')
              throw new HiveError(409, 'Archived room requires interruption');
            this.db.prepare('UPDATE room_tasks SET version=?,status=? WHERE task_id=?')
              .run(room.contractVersion, action.decision === 'continue' ? 'active' : 'stop_requested', t.id);
          }
        } else if (action.type === 'summarize') {
          if (actor.role !== 'brain' || actor.id !== room.coordinatorId) throw new HiveError(403, 'Coordinating brain publishes the reviewed summary');
          if (!room.contract.originTaskId) throw new HiveError(400, 'This room has no originating task');
          if (this.running(ch.id).length) throw new HiveError(409, 'Resolve running work before the final summary');
          const origin = this.deps.tasks.get(actor, room.contract.originTaskId), target = this.channel(actor, origin.channelId);
          if (!this.deps.channels.canPost(actor, target)) throw new HiveError(403, 'Cannot publish to the originating task');
          const msg = this.message(actor, target, `Room summary · ${ch.id}\n${action.summary}\nArtifacts: ${action.artifacts.join('; ') || 'none'}\nSummary is not acceptance of the originating task.`, [origin.workerId], origin.id);
          messages.push(msg); room.summarySeq = msg.seq;
        }
      }
      room.revision++; room.updatedAt = Date.now(); room.humanInstructionSeq = instruction;
      room.changedBy = { id: actor.id, name: actor.name, role: actor.role, reason: 'reason' in action ? action.reason : action.type };
      const notify = action.type !== 'acknowledge';
      const targets = !notify ? [] : 'taskId' in action ? [room.coordinatorId, this.deps.tasks.get(actor, action.taskId).workerId] :
        [room.coordinatorId, ...room.participantIds, ...(previousCoordinator ? [previousCoordinator] : [])];
      const message = this.message(actor, ch, `Room ${action.type} · revision ${room.revision} / contract ${room.contractVersion}\n` +
        (action.type === 'acknowledge' ? 'Worker acknowledged the current room contract (not task completion).' :
          `Read get_room for the effective rules and task fences. ${'reason' in action ? action.reason : ''}`), targets,
        null, notify ? 'decision' : 'acknowledgement');
      room.lastEventSeq = message.seq;
      // Finite closure waives a fresh instruction for the brain, not the authority
      // boundary of a direct Human decision. Older requests must not undo it.
      if (['configure', 'archive', 'reopen'].includes(action.type) && (actor.role === 'human' || !finiteClosure)) {
        room.authoritySeq = actor.role === 'human' ? message.seq : instruction!;
        if (actor.role === 'human') room.humanInstructionSeq = null;
      }
      this.persist(room);
      this.db.prepare('INSERT INTO room_events(actor_id,request_id,channel_id,hash,message_id,revision,snapshot) VALUES(?,?,?,?,?,?,?)')
        .run(actor.id, input.requestId, ch.id, hash, message.id, room.revision, JSON.stringify(room));
      messages.push(this.deps.messageQueries.getMessageById(message.id));
      return false;
    });
    if (!duplicate) {
      for (const message of messages) this.deps.messages.publishTaskMessage(message);
      this.roomChanged(ch.id);
    }
    return { ...this.view(actor, ch.id), duplicate };
  }
  /** True when the actor already used `requestId` for a room event. */
  hasRequest(actorId: string, requestId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM room_events WHERE actor_id=? AND request_id=?').get(actorId, requestId));
  }
  taskInfo(task: TaskSnapshot): RoomTask | undefined {
    const link = this.db.prepare('SELECT * FROM room_tasks WHERE task_id=?').get(task.id) as TaskLink | undefined;
    if (!link) return;
    const room = this.peek(link.channel_id)!;
    const ack = this.db.prepare('SELECT version FROM room_acks WHERE channel_id=? AND actor_id=?').get(link.channel_id, task.workerId);
    return { channelId: link.channel_id, contractVersion: link.version, currentVersion: room.contractVersion, roomRevision: room.revision, actionKey: link.action_key,
      status: link.status === 'active' && link.version !== room.contractVersion && !finished(task) ? 'needs_reconciliation' : link.status,
      acknowledged: ack?.version === room.contractVersion };
  }
  assignment(actor: Agent, channel: Channel, worker: Agent, input: { room?: { contractVersion: number; actionKey: string }; contract: unknown }) {
    const room = this.peek(channel.id);
    if (!room) {
      if (input.room) throw new HiveError(400, 'No room contract in this channel; omit room or configure/read get_room before assigning');
      return;
    }
    if (actor.id !== room.coordinatorId || !room.participantIds.includes(worker.id)) throw new HiveError(403, 'Room tasks belong to its coordinator and declared workers');
    if (!input.room) throw new HiveError(409, 'Room assignment requires current contractVersion and a stable actionKey');
    const payloadHash = this.hash({ worker: worker.id, contract: input.contract });
    const existing = this.db.prepare('SELECT * FROM room_tasks WHERE channel_id=? AND action_key=?').get(channel.id, input.room.actionKey) as TaskLink | undefined;
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new HiveError(409, 'Room actionKey already identifies different work');
      return { existing: existing.task_id, hash: payloadHash };
    }
    if (room.state !== 'active') throw new HiveError(409, 'Room is archived; new work is forbidden');
    if (this.running(channel.id).length >= 64) throw new HiveError(409, 'Room has 64 running tasks; finish or stop work before assigning more');
    if (input.room.contractVersion !== room.contractVersion) throw new HiveError(409, 'Stale room contract; get_room before assigning');
    return { hash: payloadHash };
  }
  linkTask(task: TaskSnapshot, room: { contractVersion: number; actionKey: string }, hash: string) {
    this.db.prepare("INSERT INTO room_tasks(task_id,channel_id,version,action_key,payload_hash,status) VALUES(?,?,?,?,?,'active')")
      .run(task.id, task.channelId, room.contractVersion, room.actionKey, hash);
  }
  checkTask(actor: Agent, task: TaskSnapshot, action: string) {
    const room = this.peek(task.channelId); if (!room) return;
    const info = this.taskInfo(task);
    // Installing a contract requires all earlier work to be finished. It must
    // remain historical instead of being revived outside the room's task gates.
    if (!info) throw new HiveError(409, 'Tasks predating this room contract stay historical; assign a new room task with a new actionKey');
    if (['block', 'reject', 'checkpoint', 'release_claim'].includes(action)) return;
    if (info.status !== 'active') throw new HiveError(409, `Room task is ${info.status}; read get_room and reconcile or confirm stopped`);
    if (actor.role === 'worker' && !info.acknowledged) throw new HiveError(409, 'Acknowledge the current room contract before continuing the task');
    if (action === 'revise' && room.state === 'archived') throw new HiveError(409, 'Cannot revise work in an archived room');
    if (action === 'revise' && finished(task)) throw new HiveError(409, 'Completed room work stays historical; assign a new task with a new actionKey');
  }
  private saveLink(channel: string, link: SourceLink) {
    this.db.prepare('INSERT INTO source_links(channel_id,bot_id,id,snapshot) VALUES(?,?,?,?) ON CONFLICT(channel_id,bot_id,id) DO UPDATE SET snapshot=excluded.snapshot')
      .run(channel, link.botId, link.id, JSON.stringify(link));
  }
  private requestLinks(channel: string, desired: SourceLink['desired']) {
    for (const link of this.links(channel)) this.saveLink(channel, { ...link, desired, generation: link.generation + 1,
      observed: link.suspendSupported ? 'pending' : 'unsupported', detail: '', updatedAt: Date.now() });
  }
  private botChannel(bot: Agent, channel: string) {
    if (bot.role !== 'bot') throw new HiveError(403, 'Bot credential required');
    const ch = this.channel(bot, channel);
    if (!['private', 'public'].includes(ch.type)) throw new HiveError(403, 'Source links require public/private channels');
    return ch;
  }
  botLinks(bot: Agent, channel: string) { const ch = this.botChannel(bot, channel); return this.links(ch.id).filter(l => l.botId === bot.id); }
  registerLink(bot: Agent, channel: string, raw: unknown) {
    const ch = this.botChannel(bot, channel), p = sourceLinkSchema.safeParse(raw);
    if (!p.success) throw new HiveError(400, 'Invalid source link');
    const previous = this.botLinks(bot, ch.id).find(l => l.id === p.data.id);
    if (previous) {
      if (previous.label !== p.data.label || previous.suspendSupported !== p.data.suspendSupported) throw new HiveError(409, 'Source link ID already registered with different metadata');
      return previous;
    }
    if (this.links(ch.id).length >= 64) throw new HiveError(400, 'Source link limit reached');
    const link: SourceLink = { ...p.data, botId: bot.id, desired: this.peek(ch.id)?.state === 'archived' ? 'paused' : 'running',
      generation: 1, observed: this.peek(ch.id)?.state === 'archived' && !p.data.suspendSupported ? 'unsupported' : 'pending', detail: '', updatedAt: Date.now() };
    this.saveLink(ch.id, link); this.roomChanged(ch.id); return link;
  }
  reportLink(bot: Agent, channel: string, id: string, raw: unknown) {
    const ch = this.botChannel(bot, channel), p = sourceReportSchema.safeParse(raw);
    if (!p.success) throw new HiveError(400, 'Invalid source status');
    const link = this.botLinks(bot, ch.id).find(l => l.id === id);
    if (!link) throw new HiveError(404, 'Source link not found');
    if (p.data.generation !== link.generation) throw new HiveError(409, 'Stale source command; reread links');
    if (['running', 'paused'].includes(p.data.observed) && p.data.observed !== link.desired) throw new HiveError(409, 'Report does not match the requested state');
    if (link.observed === p.data.observed && link.detail === p.data.detail) return link;
    const next = { ...link, ...p.data, updatedAt: Date.now() };
    const room = this.peek(ch.id); let message: Message | undefined;
    this.deps.storage.transaction(() => {
      this.saveLink(ch.id, next);
      // Lifecycle acknowledgements must still work after Publish is revoked, but
      // cannot create messages or wake a coordinator without that grant.
      if (room && this.deps.bots.access(bot).capabilities.includes('publish') &&
          (link.desired === 'paused' || ['failed', 'unsupported'].includes(next.observed))) {
        message = this.message(bot, ch, `Source lifecycle report · ${id} · generation ${link.generation}\nRequested ${link.desired}; bot reports ${next.observed}.\nRead get_room for status. This is a bot claim, not independent verification or new authority.`, [room.coordinatorId]);
      }
    });
    if (message) this.deps.messages.publishTaskMessage(message);
    this.roomChanged(ch.id); return next;
  }
}
