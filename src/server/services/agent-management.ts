import { createHash } from 'node:crypto';
import { HiveError, type Agent, type AgentTrafficView, type InboxStatus, type QueueEstimate } from '../../shared/types.ts';
import { agentRemoveSchema, agentRuntimeEventSchema, type AgentOverview, type AgentProfile,
  type AgentRemoveImpact } from '../../shared/agent-management.ts';
import type { CapabilityView } from '../../shared/routing.ts';
import type { AgentWork } from '../../shared/tasks.ts';
import type { TaskOverview } from '../../shared/task-views.ts';
import { terminalSessionName } from '../../shared/terminal-session.ts';
import type { Core } from './ports.ts';

type Deps = Core & {
  readonly identity: { getAgent(id: string): Agent; editIdentity(actor: Agent, id: string, input: unknown): Agent };
  readonly lifecycle: { removeAgent(actor: Agent, name: string): Agent };
  readonly lifecycleLog: { list(agentId: string, before?: number, limit?: number): {
    items: AgentOverview['lifecycle']; hasMore: boolean; nextBefore: number | null };
    record(input: { agentId: string; projectId: string | null; actorId: string | null;
      kind: 'stop_requested' | 'stop_observed'; summary: string; source: 'human_ui' }): AgentOverview['lifecycle'][number] };
  readonly activity: { forAgent(agent: Agent): NonNullable<Agent['activity']> };
  readonly tasks: { workStatus(): Record<string, AgentWork> };
  readonly taskViews: { get(actor: Agent, id: string): TaskOverview };
  readonly workerTemplates: { list(projectId: string): Array<{ id: string; spec: {
    label: string; software: string; model: string; effort: string } }> };
  readonly routing: { get(actor: Agent, id: string): CapabilityView | null };
  readonly inbox: { status(agentId: string): InboxStatus };
  readonly inboxReader: { estimate(agent: Agent): QueueEstimate };
  readonly traffic: { snapshot(ids: Iterable<string>): Record<string, AgentTrafficView> };
};

type ImpactRow = { id: string; revision: number };

/** Human agent detail, identity actions and a removal preview backed by the same task predicates as removal. */
export class AgentManagement {
  constructor(private readonly deps: Deps) {}
  private get db() { return this.deps.storage.db; }

  private target(actor: Agent, id: string): Agent {
    if (actor.role !== 'human') throw new HiveError(403, 'Only Human manages agents');
    const agent = this.deps.identity.getAgent(id);
    if (agent.role === 'human' || agent.role === 'bot') throw new HiveError(404, 'Agent panel is for brains and workers');
    return agent;
  }

  private profile(agent: Agent): AgentProfile {
    if (!agent.templateId) return { type: 'fixed' };
    const live = agent.projectId ? this.deps.workerTemplates.list(agent.projectId).find(t => t.id === agent.templateId) : null;
    const saved = this.db.prepare(`SELECT template_snapshot FROM launch_requests WHERE agent_id=?
      ORDER BY requested_at DESC,rowid DESC LIMIT 1`).get(agent.id) as { template_snapshot: string } | undefined;
    let savedLabel: string | null = null;
    if (saved) try {
      const value = JSON.parse(saved.template_snapshot) as { label?: unknown };
      if (typeof value.label === 'string') savedLabel = value.label;
    } catch { /* A deleted/corrupt template has no reliable historical configuration. */ }
    return { type: 'task_bound', templateId: agent.templateId, label: live?.spec.label ?? savedLabel,
      software: live?.spec.software ?? null, model: live?.spec.model ?? null, effort: live?.spec.effort ?? null,
      configurationSource: live ? 'current_template' : 'unavailable' };
  }

  overview(actor: Agent, id: string): AgentOverview {
    return this.deps.storage.transaction(() => {
      const agent = this.target(actor, id);
      const work = this.deps.tasks.workStatus()[id] ?? null;
      const currentTask = work?.task ? this.deps.taskViews.get(actor, work.task.id) : null;
      const inbox = { ...this.deps.inbox.status(id), queued: this.deps.inboxReader.estimate(agent) };
      const traffic = this.deps.traffic.snapshot([id])[id] ?? null;
      const capability = agent.role === 'worker' ? this.deps.routing.get(actor, id) : null;
      const resumeAliases = (this.db.prepare('SELECT name FROM agent_name_aliases WHERE agent_id=? ORDER BY created_at,name')
        .all(id) as { name: string }[]).map(row => row.name);
      return { agent: agent.removedAt === undefined && agent.archivedAt === undefined
        ? { ...agent, activity: this.deps.activity.forAgent(agent) } : agent,
        identityRevision: agent.identityRevision ?? 1, resumeAliases, profile: this.profile(agent), work, currentTask,
        inbox, traffic, capability, lifecycle: this.deps.lifecycleLog.list(id, undefined, 20).items };
    }, { immediate: false });
  }

  editIdentity(actor: Agent, id: string, input: unknown): { agent: Agent; identityRevision: number } {
    this.target(actor, id);
    const agent = this.deps.identity.editIdentity(actor, id, input);
    return { agent, identityRevision: agent.identityRevision! };
  }

  private impact(actor: Agent, id: string): AgentRemoveImpact {
    const agent = this.target(actor, id);
    if (agent.removedAt !== undefined || agent.archivedAt !== undefined) throw new HiveError(409, 'Agent is no longer active');
    const open = `json_extract(snapshot,'$.state') NOT IN ('accepted_complete','rejected','cancelled')`;
    const cancelled = this.db.prepare(`SELECT id,json_extract(snapshot,'$.revision') AS revision FROM task_records
      WHERE worker_id=? AND ${open} ORDER BY id`).all(id) as ImpactRow[];
    const unreviewed = this.db.prepare(`SELECT id,json_extract(snapshot,'$.revision') AS revision FROM task_records
      WHERE json_extract(snapshot,'$.assignerId')=? AND worker_id!=? AND ${open} ORDER BY id`).all(id, id) as ImpactRow[];
    const terminalSession = agent.terminalSession ?? null;
    const request = this.db.prepare(`SELECT id,state,session FROM launch_requests WHERE agent_id=?
      ORDER BY requested_at DESC,rowid DESC LIMIT 1`).get(id) as
      { id: string; state: string; session: string | null } | undefined;
    const close = request ? this.db.prepare(`SELECT state FROM launcher_commands WHERE request_id=? AND kind='kill'
      ORDER BY rowid DESC LIMIT 1`).get(request.id) as { state: string } | undefined : undefined;
    const launch = request ? { requestId: request.id, state: request.state, session: request.session,
      closeState: close?.state ?? null } : null;
    const pendingLaunch = Boolean(launch && ['awaiting_approval', 'approved', 'launching'].includes(launch.state));
    const pendingNativeCleanup = Boolean(launch?.session && launch.closeState !== 'done');
    const impactToken = createHash('sha256').update(JSON.stringify({ id, identityRevision: agent.identityRevision,
      terminalSession, launch, cancelled, unreviewed })).digest('hex');
    return { agentId: id, name: agent.name, cancelled: { count: cancelled.length, taskIds: cancelled.slice(0, 100).map(row => row.id) },
      unreviewed: { count: unreviewed.length, taskIds: unreviewed.slice(0, 100).map(row => row.id) },
      terminalSession, launch, pendingLaunch, pendingNativeCleanup, impactToken };
  }

  removeImpact(actor: Agent, id: string): AgentRemoveImpact {
    return this.deps.storage.transaction(() => this.impact(actor, id), { immediate: false });
  }

  remove(actor: Agent, id: string, raw: unknown): Agent {
    const parsed = agentRemoveSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid removal impact token');
    return this.deps.storage.transaction(() => {
      const current = this.impact(actor, id);
      if (current.impactToken !== parsed.data.impactToken) throw new HiveError(409, 'Removal impact changed; review it again');
      return this.deps.lifecycle.removeAgent(actor, current.name);
    });
  }

  lifecycle(actor: Agent, id: string, before?: number, limit?: number) {
    this.target(actor, id);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new HiveError(400, 'Invalid lifecycle cursor');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))
      throw new HiveError(400, 'Lifecycle limit must be 1–100');
    return this.deps.lifecycleLog.list(id, before, limit);
  }

  runtimeEvent(actor: Agent, id: string, raw: unknown) {
    const agent = this.target(actor, id);
    const parsed = agentRuntimeEventSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid runtime observation');
    const { kind, session } = parsed.data;
    // The native broker verifies the actual project/session before a Human UI stop.
    // This endpoint records that UI observation only; a renamed agent may keep an
    // owned native session under an old alias after its server label was cleared.
    if (!terminalSessionName(session)) throw new HiveError(400, 'Invalid native session label');
    return this.deps.lifecycleLog.record({ agentId: id, projectId: agent.projectId, actorId: actor.id,
      kind, summary: kind === 'stop_requested' ? `Human UI requested a native stop for ${session}.` :
        `Human UI reported native stop acknowledgement for ${session}.`, source: 'human_ui' });
  }
}
