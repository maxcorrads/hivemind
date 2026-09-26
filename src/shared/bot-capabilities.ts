import { z } from 'zod';

export const BOT_CAPABILITIES = ['publish', 'receive', 'tools'] as const;
export type BotCapability = typeof BOT_CAPABILITIES[number];
export const botCapabilitiesSchema = z.array(z.enum(BOT_CAPABILITIES)).max(3)
  .refine(values => new Set(values).size === values.length, 'Duplicate capability');
export const botAccessSchema = z.object({
  capabilities: botCapabilitiesSchema,
  receiveChannels: z.array(z.string().min(1).max(200)).max(100),
  definitionId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).nullable(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
}).strict().refine(value => new Set(value.receiveChannels).size === value.receiveChannels.length, 'Duplicate channel')
  .refine(value => value.capabilities.includes('receive') || value.receiveChannels.length === 0, 'Enable Receive before subscribing to channels')
  .refine(value => !value.capabilities.includes('tools') || value.definitionId !== null, 'Tools require an installed bot definition');

export type BotAccess = {
  capabilities: BotCapability[];
  receiveChannels: string[];
  definitionId: string | null;
  revision: number;
};

export const BOT_CAPABILITY_LABELS: Record<BotCapability, { name: string; description: string }> = {
  publish: { name: 'Publish', description: 'Post observations to channels this bot has joined.' },
  receive: { name: 'Receive', description: 'Read messages in explicitly selected channels. Messages are context, not authorization.' },
  tools: { name: 'Tools', description: 'Expose this bot’s functions to brains in this project. No AI model is implied.' },
};
