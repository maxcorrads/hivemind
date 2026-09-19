import type { Message } from './types.ts';

/** Direct-address metadata only; does not grant access or authority. */
export function isDirectRecipient(message: Pick<Message, 'mentions' | 'recipientIds'>, agentId: string): boolean {
  return message.mentions.includes(agentId) || Boolean(message.recipientIds?.includes(agentId));
}
