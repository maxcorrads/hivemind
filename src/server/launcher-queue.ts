import { createHash, randomUUID } from "node:crypto";
import { HiveError, type Agent, type Project } from "../shared/types.ts";
import { buildLaunchCommand, projectLaunchTools } from "../shared/launch-prompt.ts";
import { terminalSessionName } from "../shared/terminal-session.ts";
import type { WorkerTemplate } from "../shared/worker-templates.ts";
import { launchContext } from "./plugins.ts";
import type { Core } from "./services/ports.ts";
import { LauncherQueueCipher } from "./launcher-queue-crypto.ts";

type RequestState = "awaiting_approval" | "approved" | "launching" | "launched" | "failed" | "rejected" | "cancelled" | "expired";
type RequestRow = { id: string; project_id: string; brain_id: string; template_id: string | null; template_snapshot: string; task_id: string | null;
  job_id: string | null; agent_id: string; ticket_hash: string; state: RequestState; reason: string | null;
  requested_at: number; decided_by: string | null; decided_at: number | null; session: string | null; error: string | null;
  launch_kind: "claim" | "resume" };
type CommandRow = { id: string; request_id: string | null; kind: "launch" | "kill";
  state: "queued" | "dispatched" | "done" | "failed" | "cancelled"; payload: string;
  created_at: number; updated_at: number; error: string | null };

export type LaunchRequestView = { id: string; projectId: string; brainId: string; templateId: string; templateLabel: string;
  taskId: string | null; jobId: string | null; agentId: string; state: RequestState; reason: string | null;
  launchKind: "claim" | "resume";
  requestedAt: number; decidedBy: string | null; decidedAt: number | null; session: string | null;
  error: string | null; capBlocked: boolean };
export type LauncherCommand = { id: string; kind: "launch"; requestId: string; templateId: string;
  project: string; agent: string; title: string; session: string; command: string; cwd: string | null;
  environment: Record<string, string> } | { id: string; kind: "kill"; session: string };

export type LauncherQueueDeps = Core & { readonly home: string;
  readonly identity: { getAgent(id: string): Agent; archiveTaskWorker(agentId: string): Agent; suspendSession(agentId: string): Agent;
    templateWorkerCount(templateId: string): number;
    retargetReservation(actor: Agent, agentId: string, template: WorkerTemplate): Agent };
  readonly projects: { getProject(id: string): Project };
  readonly workerTemplates: { get(id: string): WorkerTemplate };
  readonly lifecycle: { expireReservation(agentId: string): void };
  readonly tasks: { get(actor: Agent, taskId: string): { workerId: string; jobId?: string | null };
    launchOutcome(taskId: string, requestId: string, workerId: string, state: "launched" | "failed" | "rejected" | "expired"): void;
    resumeOutcome(taskId: string, requestId: string, workerId: string, state: "launched" | "failed" | "rejected" | "expired"): void;
    hardStopCompleted(taskId: string, workerId: string): void;
    canLaunchResume(taskId: string, workerId: string, requestId: string): boolean } };

/** Matches HivemindKit SessionName(project:agent:) for the generated worker names. */
function sessionComponent(value: string, limit: number, fallback: string): string {
  const result = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-/, "").slice(0, limit).replace(/-+$/, "");
  return result || fallback;
}
function workerSession(project: string, agent: string): string {
  const p = sessionComponent(project, 32, "project");
  let a = sessionComponent(agent, 46, "agent");
  if (/^new-\d+$/.test(a)) a = `a-${a}`.slice(0, 46);
  const session = terminalSessionName(`hm-${p}-${a}`);
  if (!session) throw new HiveError(500, "Invalid reserved worker session");
  return session;
}

/** Durable intent; only the signed launcher channel can read command payloads and the single-use claim ticket. */
export class LauncherQueue {
  private readonly cipher: LauncherQueueCipher;
  constructor(private readonly deps: LauncherQueueDeps) {
    const pending = deps.storage.db.prepare("SELECT payload FROM launcher_commands WHERE state IN ('queued','dispatched')")
      .all() as { payload: string }[];
    this.cipher = new LauncherQueueCipher(deps.home, pending.length > 0);
    for (const row of pending) this.cipher.open(row.payload); // fail closed before accepting requests
  }
  private get db() { return this.deps.storage.db; }

  private row(id: string): RequestRow {
    const row = this.db.prepare("SELECT * FROM launch_requests WHERE id = ?").get(id) as RequestRow | undefined;
    if (!row) throw new HiveError(404, "Launch request not found");
    return row;
  }

  private capacity(templateId: string): { used: number; max: number } {
    const template = this.deps.workerTemplates.get(templateId);
    return { used: this.deps.identity.templateWorkerCount(templateId), max: template.spec.maxConcurrent };
  }

  private view(row: RequestRow): LaunchRequestView {
    const snapshot = JSON.parse(row.template_snapshot) as { id: string; label: string };
    const capBlocked = row.state === "awaiting_approval" && row.template_id !== null &&
      (() => { const cap = this.capacity(row.template_id!); return cap.used >= cap.max; })();
    return { id: row.id, projectId: row.project_id, brainId: row.brain_id, templateId: row.template_id ?? snapshot.id,
      templateLabel: snapshot.label,
      taskId: row.task_id, jobId: row.job_id, agentId: row.agent_id, state: row.state, reason: row.reason,
      launchKind: row.launch_kind,
      requestedAt: row.requested_at, decidedBy: row.decided_by, decidedAt: row.decided_at, session: row.session,
      error: row.error, capBlocked };
  }

  private changed(id: string): void {
    this.deps.storage.afterCommit(() => {
      this.deps.bus.emit("launch-requests", { request: this.get(id) });
      this.deps.bus.emit("launcher-queue");
    });
  }

  get(id: string): LaunchRequestView { return this.view(this.row(id)); }

  /** Public lifecycle timing for presence; never exposes command payloads or claim tickets. */
  launchPresence(agentId: string): { state: string; since: number } | null {
    const row = this.db.prepare(`SELECT r.state, COALESCE((SELECT c.updated_at FROM launcher_commands c
      WHERE c.request_id=r.id AND c.kind='launch' ORDER BY c.created_at DESC,c.id DESC LIMIT 1),r.requested_at) AS since
      FROM launch_requests r WHERE r.agent_id=? ORDER BY r.requested_at DESC,r.rowid DESC LIMIT 1`)
      .get(agentId) as { state: string; since: number } | undefined;
    return row ?? null;
  }

  list(): LaunchRequestView[] {
    return (this.db.prepare("SELECT * FROM launch_requests ORDER BY requested_at DESC, id DESC LIMIT 200").all() as RequestRow[])
      .map(row => this.view(row));
  }

  listPending(): LaunchRequestView[] {
    return (this.db.prepare("SELECT * FROM launch_requests WHERE state = 'awaiting_approval' ORDER BY requested_at, id").all() as RequestRow[])
      .map(row => this.view(row));
  }

  /** Align approval cards with the identity reservation sweep; cancelled dispatches get a compensating kill. */
  sweepExpired(at = Date.now()): void {
    const rows = this.db.prepare("SELECT * FROM launch_requests WHERE state IN ('awaiting_approval','approved','launching')")
      .all() as RequestRow[];
    for (const row of rows) {
      const agent = this.deps.identity.getAgent(row.agent_id);
      if (agent.removedAt === undefined && (!agent.pending || agent.pending.until >= at)) continue;
      if (row.state === "launching") { this.kill(row.id); continue; }
      this.deps.storage.transaction(() => {
        this.db.prepare("UPDATE launch_requests SET state = 'expired' WHERE id = ?").run(row.id);
        this.db.prepare("UPDATE launcher_commands SET state = 'cancelled', payload = '', updated_at = ? WHERE request_id = ? AND kind = 'launch'")
          .run(at, row.id);
        if (row.task_id) {
          this.deps.tasks.launchOutcome(row.task_id, row.id, row.agent_id, "expired");
          if (agent.archivedAt === undefined && agent.removedAt === undefined) this.deps.identity.archiveTaskWorker(row.agent_id);
        } else if (agent.pending && agent.removedAt === undefined) this.deps.lifecycle.expireReservation(row.agent_id);
        this.changed(row.id);
      });
    }
  }

  /** Called within A3's reserve + task transaction. Request ID makes a retry return the original intent. */
  create(input: { requestId: string; brain: Agent; template: WorkerTemplate; agent: Agent; ticket: string;
    taskId?: string | null; jobId?: string | null; reason?: string | null; approval: boolean }): LaunchRequestView {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.requestId))
      throw new HiveError(400, "requestId must be a UUID");
    if (input.brain.role !== "brain" && input.brain.role !== "human") throw new HiveError(403, "Only a brain or Human requests a launch");
    if (input.brain.role === "brain" && input.brain.projectId !== input.template.projectId) throw new HiveError(403, "Brain and template must share a project");
    const existing = this.db.prepare("SELECT * FROM launch_requests WHERE id = ?").get(input.requestId) as RequestRow | undefined;
    if (existing) {
      if (existing.brain_id !== input.brain.id || existing.agent_id !== input.agent.id)
        throw new HiveError(409, "requestId belongs to another launch");
      return this.view(existing);
    }
    if (input.agent.projectId !== input.template.projectId || input.agent.templateId !== input.template.id ||
      !input.agent.pending || input.agent.pending.until < Date.now())
      throw new HiveError(409, "Launch needs a pending worker reserved from the template");
    if (!this.deps.projects.getProject(input.template.projectId).worktree)
      throw new HiveError(409, "Project needs a worktree before a worker can launch");
    if (!/^hmc_[0-9a-f]{48}$/.test(input.ticket)) throw new HiveError(400, "Invalid launch ticket format");
    if ((input.reason?.length ?? 0) > 500) throw new HiveError(400, "reason is too long");
    return this.deps.storage.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM launch_requests WHERE id = ?").get(input.requestId) as RequestRow | undefined;
      if (existing) {
        if (existing.brain_id !== input.brain.id || existing.agent_id !== input.agent.id)
          throw new HiveError(409, "requestId belongs to another launch");
        return this.view(existing);
      }
      const state = input.approval ? "awaiting_approval" : "approved";
      if (!input.approval) {
        const cap = this.capacity(input.template.id);
        // The caller has already reserved this worker, so the requested slot is included in used.
        if (cap.used > cap.max) throw new HiveError(409, "Worker template is at its concurrent instance cap");
      }
      const at = Date.now(), hash = createHash("sha256").update(input.ticket).digest("hex");
      this.db.prepare(`INSERT INTO launch_requests (id, project_id, brain_id, template_id, template_snapshot, task_id, job_id, agent_id,
        ticket_hash, state, reason, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.requestId, input.template.projectId, input.brain.id, input.template.id,
        JSON.stringify({ id: input.template.id, label: input.template.spec.label }), input.taskId ?? null,
        input.jobId ?? null, input.agent.id, hash, state, input.reason ?? null, at);
      // The ticket is escrowed with a private per-home key, then scrubbed when the command settles.
      this.db.prepare("INSERT INTO launcher_commands (id, request_id, kind, state, payload, created_at, updated_at) VALUES (?, ?, 'launch', 'queued', ?, ?, ?)")
        .run(randomUUID(), input.requestId, this.cipher.seal({ ticket: input.ticket }), at, at);
      this.changed(input.requestId);
      return this.get(input.requestId);
    });
  }

  /** Relaunches one hard-paused identity only after its prior native session is confirmed closed. */
  createResume(input: { requestId: string; brain: Agent; taskId: string; agent: Agent; approval: boolean }): LaunchRequestView {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.requestId))
      throw new HiveError(400, "requestId must be a UUID");
    if (input.brain.role !== "brain" || input.brain.projectId !== input.agent.projectId ||
      input.agent.role !== "worker" || !input.agent.templateId || input.agent.pending ||
      input.agent.archivedAt !== undefined || input.agent.removedAt !== undefined)
      throw new HiveError(409, "Resume requires the active task-bound identity in its brain's project");
    const template = this.deps.workerTemplates.get(input.agent.templateId);
    if (!template.spec.enabled) throw new HiveError(409, "Worker template is disabled");
    if (!this.deps.projects.getProject(template.projectId).worktree) throw new HiveError(409, "Project needs a worktree before resume");
    return this.deps.storage.transaction(() => {
      const previous = this.db.prepare("SELECT * FROM launch_requests WHERE id=?").get(input.requestId) as RequestRow | undefined;
      if (previous) {
        if (previous.launch_kind !== "resume" || previous.agent_id !== input.agent.id || previous.task_id !== input.taskId ||
          previous.brain_id !== input.brain.id) throw new HiveError(409, "requestId belongs to another launch");
        return this.view(previous);
      }
      const unsafe = this.db.prepare(`SELECT 1 FROM launch_requests r WHERE r.agent_id=? AND r.session IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM launcher_commands k WHERE k.request_id=r.id AND k.kind='kill' AND k.state='done') LIMIT 1`)
        .get(input.agent.id);
      if (unsafe) throw new HiveError(409, "Previous worker session is not confirmed closed");
      const state = input.approval ? "awaiting_approval" : "approved";
      if (!input.approval && this.capacity(template.id).used >= template.spec.maxConcurrent)
        throw new HiveError(409, "Worker template is at its concurrent instance cap");
      const task = this.deps.tasks.get(input.brain, input.taskId);
      if (task.workerId !== input.agent.id) throw new HiveError(409, "Resume requires the same assigned task");
      const at = Date.now();
      this.db.prepare(`INSERT INTO launch_requests (id,project_id,brain_id,template_id,template_snapshot,task_id,job_id,
        agent_id,ticket_hash,state,reason,requested_at,launch_kind) VALUES (?,?,?,?,?,?,?,?,'',?,?,?,'resume')`).run(
        input.requestId, template.projectId, input.brain.id, template.id,
        JSON.stringify({ id: template.id, label: template.spec.label }), input.taskId, task.jobId ?? null, input.agent.id,
        state, "Resume hard-paused task", at);
      this.db.prepare("INSERT INTO launcher_commands (id,request_id,kind,state,payload,created_at,updated_at) VALUES (?,?,'launch','queued',?,?,?)")
        .run(randomUUID(), input.requestId, this.cipher.seal({ resume: true }), at, at);
      this.changed(input.requestId);
      return this.get(input.requestId);
    });
  }

  approve(actor: Agent, id: string, templateId?: string): LaunchRequestView {
    if (actor.role !== "human") throw new HiveError(403, "Only Human approves launches");
    let expired = false;
    const decided = this.deps.storage.transaction(() => {
      const row = this.row(id);
      if (row.state !== "awaiting_approval") throw new HiveError(409, "Launch request is no longer awaiting approval");
      const agent = this.deps.identity.getAgent(row.agent_id);
      if ((row.launch_kind === "claim" && (!agent.pending || agent.pending.until < Date.now())) ||
        agent.removedAt !== undefined || agent.archivedAt !== undefined) {
        this.db.prepare("UPDATE launch_requests SET state = 'expired' WHERE id = ?").run(id);
        this.db.prepare("UPDATE launcher_commands SET state = 'cancelled', payload = '', updated_at = ? WHERE request_id = ? AND kind = 'launch'")
          .run(Date.now(), id);
        if (row.task_id) {
          if (row.launch_kind === "resume") this.deps.tasks.resumeOutcome(row.task_id, row.id, row.agent_id, "expired");
          else {
            this.deps.tasks.launchOutcome(row.task_id, row.id, row.agent_id, "expired");
            if (agent.archivedAt === undefined && agent.removedAt === undefined) this.deps.identity.archiveTaskWorker(row.agent_id);
          }
        } else if (agent.pending && agent.removedAt === undefined) this.deps.lifecycle.expireReservation(row.agent_id);
        this.changed(id);
        expired = true;
        return this.get(id);
      }
      const target = templateId ?? row.template_id;
      if (!target) throw new HiveError(409, "Worker template no longer exists");
      if (row.launch_kind === "resume" && target !== row.template_id)
        throw new HiveError(409, "Resume keeps the worker's template");
      const template = this.deps.workerTemplates.get(target);
      if (template.projectId !== row.project_id || !template.spec.enabled)
        throw new HiveError(409, "Template must be enabled in the same project");
      // Awaiting reservations do not consume approved capacity. Exclude this request after its move.
      const cap = this.capacity(target);
      if (cap.used >= cap.max) throw new HiveError(409, "Worker template is at its concurrent instance cap");
      if (target !== row.template_id) this.deps.identity.retargetReservation(actor, row.agent_id, template);
      this.db.prepare("UPDATE launch_requests SET template_id = ?, template_snapshot = ?, state = 'approved', decided_by = ?, decided_at = ? WHERE id = ?")
        .run(target, JSON.stringify({ id: template.id, label: template.spec.label }), actor.id, Date.now(), id);
      this.changed(id);
      return this.get(id);
    });
    if (expired) throw new HiveError(409, "Reserved worker expired before approval");
    return decided;
  }

  reject(actor: Agent, id: string): LaunchRequestView {
    if (actor.role !== "human") throw new HiveError(403, "Only Human rejects launches");
    return this.deps.storage.transaction(() => {
      const row = this.row(id);
      if (row.state !== "awaiting_approval") throw new HiveError(409, "Launch request is no longer awaiting approval");
      this.db.prepare("UPDATE launch_requests SET state = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?")
        .run(actor.id, Date.now(), id);
      this.db.prepare("UPDATE launcher_commands SET state = 'cancelled', payload = '', updated_at = ? WHERE request_id = ? AND kind = 'launch'")
        .run(Date.now(), id);
      if (row.task_id) {
        if (row.launch_kind === "resume") this.deps.tasks.resumeOutcome(row.task_id, row.id, row.agent_id, "rejected");
        else {
          this.deps.tasks.launchOutcome(row.task_id, row.id, row.agent_id, "rejected");
          this.deps.identity.archiveTaskWorker(row.agent_id);
        }
      } else this.deps.lifecycle.expireReservation(row.agent_id);
      this.changed(id);
      return this.get(id);
    });
  }

  /** A4 stop/cancel seam: prevent any later launch replay and durably enqueue an exact-session kill. */
  kill(requestId: string): void {
    this.deps.storage.transaction(() => {
      const row = this.row(requestId);
      if (row.state === "cancelled" || row.state === "failed") {
        if (!row.session) return;
        const previous = this.db.prepare("SELECT state FROM launcher_commands WHERE request_id = ? AND kind = 'kill' ORDER BY rowid DESC LIMIT 1")
          .get(requestId) as { state: CommandRow["state"] } | undefined;
        // A failed kill has an uncertain outcome. Only an explicit control action may enqueue a new command ID.
        if (previous?.state !== "failed" && !(row.state === "failed" && !previous)) return;
        const at = Date.now();
        this.db.prepare("INSERT INTO launcher_commands (id, request_id, kind, state, payload, created_at, updated_at) VALUES (?, ?, 'kill', 'queued', ?, ?, ?)")
          .run(randomUUID(), requestId, this.cipher.seal({ session: row.session }), at, at);
        this.changed(requestId);
        return;
      }
      if (row.state === "rejected" || row.state === "expired") return;
      this.db.prepare("UPDATE launch_requests SET state = 'cancelled' WHERE id = ?").run(requestId);
      this.db.prepare("UPDATE launcher_commands SET state = 'cancelled', payload = '', updated_at = ? WHERE request_id = ? AND kind = 'launch' AND state IN ('queued','dispatched')")
        .run(Date.now(), requestId);
      if ((row.state === "approved" || row.state === "awaiting_approval") &&
        this.deps.identity.getAgent(row.agent_id).archivedAt === undefined) this.deps.lifecycle.expireReservation(row.agent_id);
      if (row.session) this.db.prepare("INSERT INTO launcher_commands (id, request_id, kind, state, payload, created_at, updated_at) VALUES (?, ?, 'kill', 'queued', ?, ?, ?)")
        .run(randomUUID(), requestId, this.cipher.seal({ session: row.session }), Date.now(), Date.now());
      this.changed(requestId);
    });
  }

  /** A reservation timed out before claim: preserve expiry, scrub launch escrow, and close any uncertain dispatch. */
  expireReservationRequest(requestId: string): void {
    this.deps.storage.transaction(() => {
      const row = this.row(requestId);
      if ((row.state === 'awaiting_approval' || row.state === 'approved') && !row.session) {
        this.db.prepare("UPDATE launch_requests SET state='expired' WHERE id=?").run(requestId);
        this.db.prepare(`UPDATE launcher_commands SET state='cancelled',payload='',updated_at=?
          WHERE request_id=? AND kind='launch'`).run(Date.now(), requestId);
        this.changed(requestId);
      } else if (row.session || row.state === 'launching' || row.state === 'launched') {
        this.kill(requestId);
      }
    });
  }

  /** Template deletion may proceed only after no live worker or pending command uses it. */
  hasActiveTemplateRequests(templateId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM launch_requests WHERE template_id = ? AND state IN ('awaiting_approval','approved','launching') LIMIT 1")
      .get(templateId));
  }

  /** Called before project agents and templates are deleted, inside their transaction. */
  purgeProject(projectId: string): void {
    const active = this.db.prepare(`SELECT 1 FROM launch_requests r LEFT JOIN launcher_commands c ON c.request_id = r.id
      WHERE r.project_id = ? AND (r.state IN ('awaiting_approval','approved','launching','launched')
        OR c.state = 'dispatched' OR (c.kind = 'kill' AND c.state IN ('queued','failed')
          AND c.rowid = (SELECT MAX(k.rowid) FROM launcher_commands k WHERE k.request_id = r.id AND k.kind = 'kill'))) LIMIT 1`)
      .get(projectId);
    if (active) throw new HiveError(409, "Settle launch and session commands before deleting the project");
    this.db.prepare("DELETE FROM launch_requests WHERE project_id = ?").run(projectId);
  }

  /** Stable command ID and payload across polls/restarts. Native deduplicates by this ID and session. */
  next(serverUrl: string): LauncherCommand | null {
    return this.deps.storage.transaction(() => {
      const command = this.db.prepare(`SELECT c.* FROM launcher_commands c LEFT JOIN launch_requests r ON r.id = c.request_id
        WHERE c.state = 'dispatched' OR (c.state = 'queued' AND (c.kind = 'kill' OR r.state = 'approved'))
        ORDER BY c.created_at, c.id LIMIT 1`).get() as CommandRow | undefined;
      if (!command) return null;
      if (command.state === "dispatched") return this.cipher.open<LauncherCommand>(command.payload);
      let payload: LauncherCommand;
      if (command.kind === "kill") {
        const privatePayload = this.cipher.open<{ session: string }>(command.payload);
        if (!terminalSessionName(privatePayload.session)) throw new HiveError(500, "Invalid queued session");
        payload = { id: command.id, kind: "kill", session: privatePayload.session };
      } else {
        const row = this.row(command.request_id!);
        const agent = this.deps.identity.getAgent(row.agent_id), project = this.deps.projects.getProject(row.project_id);
        if (!row.template_id) throw new HiveError(409, "Worker template no longer exists");
        const template = this.deps.workerTemplates.get(row.template_id);
        const resuming = row.launch_kind === "resume";
        const invalid = resuming
          ? Boolean(agent.pending || !row.task_id || !this.deps.tasks.canLaunchResume(row.task_id, agent.id, row.id) ||
            agent.removedAt !== undefined || agent.archivedAt !== undefined || !template.spec.enabled)
          : Boolean(!agent.pending || agent.pending.until < Date.now() || agent.removedAt !== undefined ||
            agent.archivedAt !== undefined || !template.spec.enabled);
        if (invalid) {
          this.db.prepare("UPDATE launch_requests SET state = ? WHERE id = ?").run(resuming ? "failed" : "expired", row.id);
          this.db.prepare("UPDATE launcher_commands SET state = 'cancelled', payload = '', updated_at = ? WHERE id = ?").run(Date.now(), command.id);
          this.changed(row.id);
          if (row.task_id) {
            if (resuming) this.deps.tasks.resumeOutcome(row.task_id, row.id, row.agent_id, "failed");
            else {
              this.deps.tasks.launchOutcome(row.task_id, row.id, row.agent_id, "expired");
              if (agent.archivedAt === undefined && agent.removedAt === undefined) this.deps.identity.archiveTaskWorker(row.agent_id);
            }
          } else if (agent.pending && agent.removedAt === undefined) this.deps.lifecycle.expireReservation(row.agent_id);
          return null;
        }
        const ticket = resuming ? undefined : this.cipher.open<{ ticket: string }>(command.payload).ticket;
        if (!resuming && createHash("sha256").update(ticket!).digest("hex") !== row.ticket_hash)
          throw new HiveError(500, "Launch ticket integrity failed");
        const context = launchContext(this.deps.home, serverUrl, project);
        if (context.pluginError) throw new HiveError(503, "Project launch context is unavailable");
        const built = buildLaunchCommand({ software: template.spec.software, model: template.spec.model,
          effort: template.spec.effort, extraFlags: template.spec.extraFlags,
          ...projectLaunchTools(context, project, "worker"), workspacePath: project.worktree,
          cdWorktree: Boolean(project.worktree), projectSlug: project.slug, hiveName: project.name,
          passProject: true, role: "worker", seniority: template.spec.seniority, focus: template.spec.focus || null,
          adoptUntrusted: true, claim: ticket, claimName: agent.name,
          resume: resuming, resumeName: resuming ? agent.name : undefined });
        if (!built.cwd) throw new HiveError(409, "Project needs a worktree before a worker can launch");
        const session = workerSession(project.slug, agent.name);
        payload = { id: command.id, kind: "launch", requestId: row.id, templateId: template.id,
          project: project.slug, agent: agent.name, title: template.spec.label,
          session, command: built.command, cwd: built.cwd, environment: template.spec.environment };
        this.db.prepare("UPDATE launch_requests SET state = 'launching', session = ? WHERE id = ?").run(session, row.id);
        this.changed(row.id);
      }
      this.db.prepare("UPDATE launcher_commands SET state = 'dispatched', payload = ?, updated_at = ? WHERE id = ?")
        .run(this.cipher.seal(payload), Date.now(), command.id);
      return payload;
    });
  }

  result(id: string, input: { status: "launched" | "failed" | "killed"; session?: string; error?: string }): void {
    this.deps.storage.transaction(() => {
      const command = this.db.prepare("SELECT * FROM launcher_commands WHERE id = ?").get(id) as CommandRow | undefined;
      if (!command) throw new HiveError(404, "Launcher command not found");
      if (command.state === "done" || command.state === "failed" || command.state === "cancelled") return;
      if (command.state !== "dispatched") throw new HiveError(409, "Launcher command was not dispatched");
      const payload = this.cipher.open<LauncherCommand>(command.payload);
      if (command.kind === "launch") {
        if (input.status === "killed") throw new HiveError(400, "Launch command needs launched or failed status");
        if (input.status === "launched" && (input.session !== payload.session || !terminalSessionName(input.session)))
          throw new HiveError(400, "session must match the dispatched launch");
        const state = input.status === "launched" ? "launched" : "failed";
        // Native failure text may contain shell output or secrets. Keep only a fixed public error.
        const error = state === "failed" ? "Launch failed in Hivemind Server.app" : null;
        this.db.prepare("UPDATE launch_requests SET state = ?, error = ? WHERE id = ? AND state = 'launching'")
          .run(state, error, command.request_id);
        this.db.prepare("UPDATE launcher_commands SET state = ?, payload = '', updated_at = ?, error = ? WHERE id = ?")
          .run(state === "launched" ? "done" : "failed", Date.now(), error, id);
        if (command.request_id) {
          const row = this.row(command.request_id);
          if (row.task_id) {
            if (row.launch_kind === "resume") this.deps.tasks.resumeOutcome(row.task_id, row.id, row.agent_id, state);
            else this.deps.tasks.launchOutcome(row.task_id, row.id, row.agent_id, state);
          }
          // Even a failed adapter may have started the deterministic session before reporting failure.
          if (state === "failed" && row.session) this.db.prepare("INSERT INTO launcher_commands (id, request_id, kind, state, payload, created_at, updated_at) VALUES (?, ?, 'kill', 'queued', ?, ?, ?)")
            .run(randomUUID(), row.id, this.cipher.seal({ session: row.session }), Date.now(), Date.now());
        }
      } else {
        if (input.status !== "killed" && input.status !== "failed") throw new HiveError(400, "Kill command needs killed or failed status");
        this.db.prepare("UPDATE launcher_commands SET state = ?, payload = '', updated_at = ?, error = ? WHERE id = ?")
          .run(input.status === "killed" ? "done" : "failed", Date.now(), input.status === "failed" ? "Kill failed in Hivemind Server.app" : null, id);
        if (command.request_id) this.db.prepare("UPDATE launch_requests SET error = ? WHERE id = ?")
          .run(input.status === "failed" ? "Session close failed in Hivemind Server.app" : null, command.request_id);
        if (input.status === "killed" && command.request_id) {
          const row = this.row(command.request_id), agent = this.deps.identity.getAgent(row.agent_id);
          if (row.task_id && agent.archivedAt === undefined && agent.removedAt === undefined) {
            this.deps.tasks.hardStopCompleted(row.task_id, row.agent_id);
            this.deps.identity.suspendSession(row.agent_id);
          } else if (agent.pending && agent.removedAt === undefined && agent.archivedAt === undefined)
            this.deps.lifecycle.expireReservation(row.agent_id);
        }
      }
      if (command.request_id) this.changed(command.request_id);
      if (command.kind === "launch" && input.status === "failed" && command.request_id) {
        const row = this.row(command.request_id);
        const agent = this.deps.identity.getAgent(row.agent_id);
        if (row.task_id && row.launch_kind === "claim") {
          if (agent.archivedAt === undefined && agent.removedAt === undefined) this.deps.identity.archiveTaskWorker(row.agent_id);
        } else if (agent.pending && agent.removedAt === undefined) this.deps.lifecycle.expireReservation(row.agent_id);
      }
    });
  }
}
