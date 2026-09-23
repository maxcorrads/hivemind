import type { Hive } from './hive.ts';
import type { StatementSync } from 'node:sqlite';
import { HiveError, MESSAGE_EVENT_TYPES, type Agent } from '../shared/types.ts';
import { notificationRoute, subscriptionSchema, subscriptionScopeSchema,
  type NotificationHeader, type Subscription } from '../shared/notifications.ts';

export class NotificationStore {
  private readonly lookup: StatementSync;
  constructor(private hive: Hive) {
    this.lookup = hive.db.prepare(`SELECT event_types FROM notification_subscriptions
      WHERE agent_id = ? AND channel_id = ? AND thread_id IN ('', ?) ORDER BY length(thread_id) DESC LIMIT 1`);
  }
  private scope(actor: Agent, raw: unknown) {
    if (actor.role !== 'brain' && actor.role !== 'worker') throw new HiveError(403, 'Only agents have wake subscriptions');
    const parsed = subscriptionScopeSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid subscription scope');
    const channel = this.hive.getChannel(parsed.data.channel, actor.projectId);
    if (!this.hive.canSeeChannel(actor, channel)) throw new HiveError(403, 'Cannot subscribe outside channel access');
    if (parsed.data.threadId) {
      const root = this.hive.db.prepare('SELECT channel_id, thread_id FROM messages WHERE id = ?').get(parsed.data.threadId);
      if (!root || root.channel_id !== channel.id || root.thread_id) throw new HiveError(400, 'Subscription requires a root in this channel');
    }
    return { channel: channel.id, threadId: parsed.data.threadId };
  }
  list(actor: Agent): Subscription[] {
    if (actor.role !== 'brain' && actor.role !== 'worker') throw new HiveError(403, 'Only agents have wake subscriptions');
    return this.hive.db.prepare(`SELECT channel_id, thread_id, event_types FROM notification_subscriptions
      WHERE agent_id = ? ORDER BY channel_id, thread_id`).all(actor.id)
      .filter(row => this.hive.canSeeChannel(actor, this.hive.getChannel(String(row.channel_id))))
      .map(row => ({ channel: String(row.channel_id), ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
        eventTypes: JSON.parse(String(row.event_types)) }));
  }
  set(actor: Agent, raw: unknown) {
    const parsed = subscriptionSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid subscription');
    const { eventTypes, ...input } = parsed.data, scope = this.scope(actor, input);
    this.hive.db.prepare(`INSERT INTO notification_subscriptions(agent_id, channel_id, thread_id, event_types) VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, channel_id, thread_id) DO UPDATE SET event_types = excluded.event_types`)
      .run(actor.id, scope.channel, scope.threadId ?? '', JSON.stringify([...new Set(eventTypes)]));
    return this.list(actor);
  }
  reset(actor: Agent, raw: unknown) {
    const scope = this.scope(actor, raw);
    this.hive.db.prepare('DELETE FROM notification_subscriptions WHERE agent_id = ? AND channel_id = ? AND thread_id = ?')
      .run(actor.id, scope.channel, scope.threadId ?? '');
    return this.list(actor);
  }
  classify(actor: Agent, row: NotificationHeader, pending = false) {
    const rule = row.visible && !row.received && row.author_id !== actor.id && !pending
      ? this.lookup.get(actor.id, row.channel_id, row.root_id) : undefined;
    // An active persistent contract makes its coordinating brain the default
    // observer even in public channels. Explicit subscriptions still win.
    const room = !rule && row.visible && row.author_role === 'bot' && actor.role === 'brain'
      ? this.hive.rooms.peek(row.channel_id) : null;
    const defaults = room?.state === 'active' && room.coordinatorId === actor.id ? ['message', ...MESSAGE_EVENT_TYPES] : undefined;
    const route = notificationRoute(row, actor.id, rule ? JSON.parse(String(rule.event_types)) : defaults);
    // A changed subscription cannot invalidate or silently consume a receipt already offered.
    // Access and identity are still rechecked on every replay.
    if (pending) route.addressed = Number(Boolean(row.visible && !row.received && row.author_id !== actor.id));
    return { ...row, ...route };
  }
}
