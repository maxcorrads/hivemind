import { z } from 'zod';
import type { Agent, AgentTrafficView, InboxStatus, QueueEstimate } from './types.ts';
import type { AgentWork } from './tasks.ts';
import type { TaskOverview } from './task-views.ts';
import type { CapabilityView } from './routing.ts';

export const agentIdentityEditSchema = z.object({
  expectedRevision: z.number().int().positive().safe(),
  name: z.string().trim().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9_-]*$/).optional(),
  focus: z.string().trim().min(1).max(200).nullable().optional(),
  seniority: z.enum(['junior', 'mid', 'senior']).optional(),
}).strict().refine(value => value.name !== undefined || value.focus !== undefined || value.seniority !== undefined,
  'Provide at least one identity field');

export const agentRemoveSchema = z.object({ impactToken: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const agentRuntimeEventSchema = z.object({
  kind: z.enum(['stop_requested', 'stop_observed']),
  session: z.string().min(1).max(100),
}).strict();

export type AgentLifecycleKind = 'joined' | 'resumed' | 'superseded' | 'offline' | 'stalled' |
  'session_ended' | 'context_cleared' | 'identity_edited' | 'capability_edited' | 'removed' | 'archived' |
  'stop_requested' | 'stop_observed';
export type AgentLifecycleEvent = { seq: number; agentId: string; projectId: string | null;
  actorId: string | null; kind: AgentLifecycleKind; summary: string; at: number; source: 'server' | 'human_ui' };

export type AgentProfile = { type: 'fixed' } | { type: 'task_bound'; templateId: string;
  label: string | null; software: string | null; model: string | null; effort: string | null;
  configurationSource: 'current_template' | 'unavailable' };
export type AgentOverview = { agent: Agent; identityRevision: number; resumeAliases: string[]; profile: AgentProfile;
  work: AgentWork | null; currentTask: TaskOverview | null; inbox: InboxStatus & { queued: QueueEstimate };
  traffic: AgentTrafficView | null; capability: (CapabilityView & { lastEditorId: string | null }) | null;
  lifecycle: AgentLifecycleEvent[] };
export type AgentRemoveImpact = { agentId: string; name: string;
  cancelled: { count: number; taskIds: string[] }; unreviewed: { count: number; taskIds: string[] };
  terminalSession: string | null;
  launch: { requestId: string; state: string; session: string | null; closeState: string | null } | null;
  pendingLaunch: boolean; pendingNativeCleanup: boolean;
  impactToken: string };
