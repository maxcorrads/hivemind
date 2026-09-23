import type { Message } from '../src/shared/types.ts';
import { retainNewest } from '../src/shared/realtime.ts';

/** ACKs prove insertion, not current metadata. Keep them bounded and separate from live updates. */
export function mergeConfirmations(previous: Message[], incoming: Message[]): Message[] {
  const byId = new Map(previous.map(message => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return retainNewest([...byId.values()].sort((a, b) => a.seq - b.seq)).items;
}
