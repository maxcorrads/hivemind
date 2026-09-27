import { createHash } from "node:crypto";
import { HiveError, type Agent } from "../../shared/types.ts";
import { requestWorkerSchema, releaseWorkerSchema } from "../../shared/worker-orchestration.ts";
import type { LauncherQueue } from "../launcher-queue.ts";
import type { TaskStore } from "../tasks.ts";
import type { WorkerTemplateStore } from "../worker-templates.ts";
import type { Core } from "./ports.ts";
import type { IdentityService } from "./identity.ts";
import type { ChannelService } from "./channels.ts";
import type { MessageService } from "./messages.ts";
import type { JobStore } from "./jobs.ts";

type Deps = Core & {
  readonly identity: IdentityService;
  readonly workerTemplates: WorkerTemplateStore;
  readonly launcherQueue: LauncherQueue;
  readonly tasks: TaskStore;
  readonly channels: ChannelService;
  readonly messages: MessageService;
  readonly jobs: Pick<JobStore, "resolve" | "attach">;
};

/** One transaction owns the reservation, task assignment and encrypted launch intent. */
export class WorkerOrchestration {
  constructor(private readonly deps: Deps) {}
  private get db() { return this.deps.storage.db; }

  templates(brain: Agent) {
    if (brain.role !== "brain" || !brain.projectId) throw new HiveError(403, "Only a project brain lists worker templates");
    return { templates: this.deps.workerTemplates.list(brain.projectId).filter(template => template.spec.enabled).map(template => ({
      id: template.id, slug: template.slug, label: template.spec.label, description: template.spec.description,
      seniority: template.spec.seniority, maxConcurrent: template.spec.maxConcurrent,
      instancesInUse: this.deps.identity.templateWorkerCount(template.id),
    })) };
  }

  roster(brain: Agent): Agent[] {
    const work = this.deps.tasks.workStatus();
    return this.deps.identity.listAgents(brain).map(agent => {
      if (agent.role !== "worker") return agent;
      const assigned = work[agent.id]?.assigned ?? 0;
      return { ...agent, origin: agent.templateId ? { type: "template", templateId: agent.templateId } : { type: "fixed" },
        openTasks: assigned };
    });
  }

  request(brain: Agent, raw: unknown) {
    if (brain.role !== "brain" || !brain.projectId) throw new HiveError(403, "Only a project brain requests workers");
    const parsed = requestWorkerSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, `Invalid request_worker: ${parsed.error.message}`);
    const input = parsed.data;
    const projectId = brain.projectId;
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return this.deps.storage.transaction(() => {
      const previous = this.db.prepare("SELECT brain_id, task_id, agent_id, request_hash FROM launch_requests WHERE id=?")
        .get(input.requestId) as { brain_id: string; task_id: string | null; agent_id: string; request_hash: string | null } | undefined;
      if (previous) {
        if (previous.brain_id !== brain.id || previous.request_hash !== hash || !previous.task_id)
          throw new HiveError(409, "requestId was already used for a different worker request");
        return { task: this.deps.tasks.view(brain, previous.task_id), request: this.deps.launcherQueue.get(input.requestId),
          worker: this.deps.identity.getAgent(previous.agent_id) };
      }
      const job = input.job ? this.deps.jobs.resolve(brain, input.job, input.requestId) : null;
      const template = this.deps.workerTemplates.list(projectId).find(t => t.id === input.template || t.slug === input.template);
      if (!template) throw new HiveError(404, "Worker template not found in this project");
      if (!template.spec.enabled) throw new HiveError(409, "Worker template is disabled");
      if (input.taskId) {
        const old = this.deps.tasks.get(brain, input.taskId);
        if (old.assignerId !== brain.id) throw new HiveError(403, "Only the assigning brain can replace this task's worker");
        if (old.revision !== input.expectedRevision) throw new HiveError(409, "Task changed; get_task and use its current revision");
        const current = this.deps.identity.getAgent(old.workerId);
        if (!['cancelled', 'rejected'].includes(old.state) && current.removedAt === undefined && current.archivedAt === undefined)
          throw new HiveError(409, "Task still has an active assigned worker");
      }
      const approval = brain.launchMode !== "auto";
      const { agent, ticket } = this.deps.identity.reserve(brain, template, input.slug ?? input.contract.objective, approval);
      const oldWorker = input.taskId ? this.deps.identity.getAgent(this.deps.tasks.get(brain, input.taskId).workerId) : null;
      const channelId = this.deps.channels.createChannel(brain, { name: `task-${input.requestId}`, type: "private",
        topic: input.contract.objective.slice(0, 200), memberNames: [agent.name,
          ...(oldWorker && oldWorker.archivedAt === undefined && oldWorker.removedAt === undefined ? [oldWorker.name] : [])] }).id;
      if (input.taskId) this.deps.tasks.rehomeForReplacement(brain, input.taskId, channelId);
      const assignment = input.taskId
        ? this.deps.tasks.event(brain, input.taskId, { requestId: `${input.requestId}.task`, expectedRevision: input.expectedRevision,
          action: { type: "revise", reason: "Assign a new task-bound worker", worker: agent.name, contract: input.contract } })
        : this.deps.tasks.assign(brain, { requestId: input.requestId, worker: agent.name, channel: channelId, contract: input.contract });
      const task = job ? this.deps.jobs.attach(brain, assignment.task.id, job.id) : assignment.task;
      const request = this.deps.launcherQueue.create({ requestId: input.requestId, brain, template, agent, ticket,
        taskId: task.id, jobId: task.jobId, approval });
      this.db.prepare("UPDATE launch_requests SET request_hash=? WHERE id=?").run(hash, input.requestId);
      return { task, request, worker: agent };
    });
  }

  release(brain: Agent, raw: unknown) {
    if (brain.role !== "brain" || !brain.projectId) throw new HiveError(403, "Only a project brain releases workers");
    const parsed = releaseWorkerSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, `Invalid release_worker: ${parsed.error.message}`);
    const input = parsed.data;
    return this.deps.storage.transaction(() => {
      const worker = this.deps.identity.findAgentByName(input.worker);
      if (!worker || worker.projectId !== brain.projectId || !worker.templateId || worker.role !== "worker")
        throw new HiveError(404, "Task-bound worker not found in this project");
      const row = this.db.prepare("SELECT id, brain_id, task_id FROM launch_requests WHERE agent_id=? ORDER BY requested_at DESC, rowid DESC LIMIT 1")
        .get(worker.id) as { id: string; brain_id: string; task_id: string | null } | undefined;
      if (!row || row.brain_id !== brain.id || !row.task_id) throw new HiveError(403, "This task-bound worker belongs to another brain");
      const task = this.deps.tasks.get(brain, row.task_id);
      if (task.assignerId !== brain.id) throw new HiveError(403, "This task belongs to another brain");
      if (task.workerId === worker.id && !['accepted_complete', 'cancelled', 'rejected'].includes(task.state))
        throw new HiveError(409, "Finish, cancel or revise the task before releasing its worker");
      if (worker.archivedAt === undefined) {
        this.deps.messages.postMessage(brain, { channel: task.channelId, threadId: task.id,
          body: `${worker.name} archived: ${input.reason}`, eventType: "decision" });
        this.deps.identity.archiveTaskWorker(worker.id);
      }
      this.deps.launcherQueue.kill(row.id);
      return { worker: this.deps.identity.getAgent(worker.id), archived: true as const, request: this.deps.launcherQueue.get(row.id) };
    });
  }

  /** A terminal task closes its task-bound worker in the same transaction as the task event. */
  archiveFinishedTask(taskId: string, workerId: string): void {
    const row = this.db.prepare(`SELECT id FROM launch_requests WHERE task_id=? AND agent_id=?
      ORDER BY requested_at DESC,rowid DESC LIMIT 1`).get(taskId, workerId) as { id: string } | undefined;
    if (!row) return; // A fixed worker has no launcher request.
    const agent = this.deps.identity.getAgent(workerId);
    if (agent.archivedAt === undefined && agent.removedAt === undefined) this.deps.identity.archiveTaskWorker(workerId);
    this.deps.launcherQueue.kill(row.id);
  }

  /** Grace expiry closes the native session but keeps the identity and task for explicit resume. */
  stopForHardPause(taskId: string, workerId: string): void {
    const row = this.db.prepare(`SELECT id FROM launch_requests WHERE task_id=? AND agent_id=?
      ORDER BY requested_at DESC,rowid DESC LIMIT 1`).get(taskId, workerId) as { id: string } | undefined;
    if (!row) throw new HiveError(409, "Hard pause requires a launched task-bound worker");
    this.deps.launcherQueue.kill(row.id);
  }

  /** Human may retry a failed native close; a queued or dispatched close is never duplicated. */
  retryHardStop(taskId: string, workerId: string): void {
    const row = this.db.prepare(`SELECT id FROM launch_requests WHERE task_id=? AND agent_id=?
      ORDER BY requested_at DESC,rowid DESC LIMIT 1`).get(taskId, workerId) as { id: string } | undefined;
    if (!row) throw new HiveError(409, "Hard pause has no worker session to close");
    const latest = this.db.prepare(`SELECT state FROM launcher_commands WHERE request_id=? AND kind='kill'
      ORDER BY rowid DESC LIMIT 1`).get(row.id) as { state: string } | undefined;
    if (latest?.state !== "failed") throw new HiveError(409, "Worker close is not failed; wait for its outcome");
    this.deps.launcherQueue.kill(row.id);
  }
}
