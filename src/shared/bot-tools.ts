import { z } from 'zod';
import { settingsSchema } from './bot-settings.ts';

export const botToolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
    .refine(name => name !== 'connect', 'connect is reserved for Human-only provisioning'),
  description: z.string().min(1).max(1000),
  effect: z.enum(['read', 'configure']),
  parameters: settingsSchema,
}).strict();
export const botToolsSchema = z.array(botToolSchema).max(30)
  .refine(tools => new Set(tools.map(tool => tool.name)).size === tools.length, 'Duplicate tool');
export type BotTool = z.infer<typeof botToolSchema>;
export const botToolCallSchema = z.object({
  tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  arguments: z.record(z.string(), z.unknown()),
}).strict();
