import type { Hive } from '../hive.ts';
import type { Agent, Message } from '../../shared/types.ts';
import type { AdaptiveExecutionState } from '../../shared/adaptive-topology.ts';

type HumanInput = Parameters<Hive['messages']['postMessage']>[1];

/**
 * A Human send as the UI performs it (#214): post, then let Jev advise in the background. Waits for that advice and
 * returns the request's executions, or null when no brain owns a request (Jev off, no brain, or no single owner).
 */
export async function sendHumanRequest(hive: Hive, human: Agent, input: HumanInput, routingRequest?: string):
  Promise<{ message: Message; states: AdaptiveExecutionState[] } | null> {
  const message = hive.messages.postMessage(human, input);
  hive.adaptiveTopology.humanMessagePosted(human, message, routingRequest);
  await hive.adaptiveTopology.settled();
  const root = message.threadId ?? message.id;
  const states = (hive.adaptiveTopology.view(human, message.channelId).executions ?? []).filter(state => state.rootMessageId === root);
  return states.length ? { message, states } : null;
}
