import { z } from 'zod';
import { MESSAGE_EVENT_TYPES } from './types.ts';

export const NOTIFICATION_EVENTS = ['message', ...MESSAGE_EVENT_TYPES] as const;
/** Fixed from the first pending progress item, never extended by newer updates. */
export const ROUTINE_BATCH_MS = 250;
export const subscriptionSchema = z.object({
  channel: z.string().min(1).max(256),
  threadId: z.string().uuid().optional(),
  eventTypes: z.array(z.enum(NOTIFICATION_EVENTS)).max(NOTIFICATION_EVENTS.length),
}).strict();
export const subscriptionScopeSchema = subscriptionSchema.omit({ eventTypes: true });
export type Subscription = z.infer<typeof subscriptionSchema>;

export type NotificationHeader = {
  seq: number; channel_id: string; root_id: string; author_id: string;
  author_role: string; kind: string; event_type: string | null; type: string;
  visible: number; received: number; mentioned: number; targeted: number;
  has_targets: number; task: number; evidence: number; created_at: number;
};

/** Classification changes delivery, never access, authority or task lifecycle. */
export function notificationRoute(row: NotificationHeader, actorId: string, events?: string[]) {
  const direct = Boolean(row.mentioned || row.targeted || row.kind === 'control');
  const ackOnly = row.event_type === 'acknowledgement' && row.kind === 'chat' &&
    row.author_role !== 'human' && !row.task && !row.evidence;
  const addressed = Boolean(row.visible && !row.received && row.author_id !== actorId && !ackOnly &&
    (direct || (events ? events.includes(row.event_type ?? 'message') :
      !row.has_targets && !row.task && ['dm', 'private', 'brains'].includes(row.type))));
  const urgent = direct || Boolean(row.task) || row.author_role === 'human' ||
    ['assignment', 'decision', 'blocker', 'question', 'action_required'].includes(row.event_type ?? '');
  return { addressed: Number(addressed), urgent: Number(urgent),
    routine: addressed && !urgent && !row.evidence && row.event_type === 'progress' };
}

/** One turn per conversation before a noisy conversation gets a second turn. */
export function fairOrder<T extends { channel_id: string; root_id: string }>(items: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = JSON.stringify([item.channel_id, item.root_id]);
    const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
  }
  const result: T[] = [];
  for (let round = 0; result.length < items.length; round++) {
    for (const group of groups.values()) if (group[round]) result.push(group[round]);
  }
  return result;
}
