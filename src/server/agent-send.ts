import { randomUUID } from 'node:crypto';
import type { AgentSendDeps } from './services/ports.ts';
import { HiveError, type Agent } from '../shared/types.ts';
import { validated, sendInputSchema } from '../shared/api-contract.ts';

/** An agent's send to a channel. A retry with the same requestId answers with the message it already posted. */
export function sendAgentMessage(deps: AgentSendDeps, actor: Agent, channelRef: string, raw: unknown) {
  const input = validated(sendInputSchema, raw);
  const channel = deps.channels.getChannel(channelRef, actor.projectId);
  if (!deps.channels.canSeeChannel(actor, channel) || !deps.channels.canPost(actor, channel)) throw new HiveError(403, 'Cannot send to this channel');
  const body = input.body ?? '', requestId = input.requestId ?? randomUUID();
  const messageInput = { ...input, body, channel: channel.id, requestId };
  if (!deps.messages.hasActiveSendRequest(actor, channel.id, requestId)) {
    if (!body.trim() && !input.attachmentIds?.length) throw new HiveError(400, 'Empty message');
    if (input.threadId && deps.messageQueries.getMessageById(input.threadId).channelId !== channel.id)
      throw new HiveError(400, 'Thread is not in this channel');
  }
  const message = deps.messages.postMessage(actor, messageInput);
  return { ok: true, seq: message.seq, id: message.id };
}
