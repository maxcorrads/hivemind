import { HiveError, HUMAN_ID, type Agent } from "../../shared/types.ts";
import type { Core } from "./ports.ts";
import { now } from "./rows.ts";

export type AgentLifecycleDeps = Core & {
  readonly identity: {
    getAgent(id: string): Agent;
    getAgentByName(name: string): Agent | null;
    markRemoved(agentId: string, at: number): void;
  };
  readonly channels: { generalChannelId(projectId: string): string | null };
  readonly messages: { postSystem(channelId: string, body: string): void };
  readonly files: { deleteUnsentBy(agentId: string): void; collectUnusedBlobs(): number };
  readonly waiters: { evict(agentId: string): void };
  readonly tasks: { closeForRemovedAgent(agent: Agent): { cancelled: number; unreviewed: number } };
  readonly adaptiveTopology: { closeBrainExecutions(brain: Agent): void };
  readonly launcherQueue: { kill(requestId: string): void };
  readonly lifecycleLog?: { record(input: { agentId: string; projectId: string | null; actorId: string | null;
    kind: 'removed'; summary: string; source: 'server' }): unknown };
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * How an agent leaves the hive (#215). Both operations run inside one transaction: the caller's (project deletion) or
 * their own (removal). Events and waiter evictions happen only after the commit.
 *
 * - Removal keeps a tombstone: the agent row stays (marked `removed_at`) so its messages, tasks and routing outcomes
 *   keep their author. The agent can no longer authenticate, join, resume, receive mail or be assigned; its open work
 *   is closed: tasks assigned to it are cancelled and its Jev executions completed. Tasks it assigned stay open so
 *   their workers can still report and submit.
 * - Project deletion purges: the project's agents are deleted along with everything else the project scoped.
 */
export class AgentLifecycle {
  constructor(private readonly deps: AgentLifecycleDeps) {}

  private get db() { return this.deps.storage.db; }

  removeAgent(actor: Agent, name: string): Agent {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can remove agents");
    return this.deps.storage.transaction(() => {
      const target = this.deps.identity.getAgentByName(name);
      if (!target) throw new HiveError(404, `No agent named ${name}`);
      if (target.id === HUMAN_ID || target.role === "human") throw new HiveError(403, "Cannot remove Human");
      const removed = this.retire(target, `${actor.name} removed ${target.name} from the hive.`, actor.id);
      this.deps.storage.afterCommit(() => this.sweepBlobs());
      return removed;
    });
  }

  /** A reserved worker whose launch never joined in time: withdrawn like a removal, with a note saying why. */
  expireReservation(agentId: string): void {
    this.deps.storage.transaction(() => {
      const target = this.deps.identity.getAgent(agentId);
      if (target.removedAt !== undefined || target.archivedAt !== undefined || !target.pending) return;
      this.retire(target, `${target.name} was withdrawn: its launch did not join within 30 minutes.`);
      this.deps.storage.afterCommit(() => this.sweepBlobs());
    });
  }

  /** Inside a transaction: tombstones the agent, closes its work and posts `note` (plus what happened to its tasks). */
  private retire(target: Agent, note: string, actorId: string | null = null): Agent {
    const { identity, tasks, adaptiveTopology, channels, messages, bus, storage } = this.deps;
    this.detach(target.id);
    // Tombstone first, so the task views published below already label the agent as removed.
    identity.markRemoved(target.id, now());
    if (target.templateId) {
      const row = this.db.prepare(`SELECT id FROM launch_requests WHERE agent_id=?
        ORDER BY requested_at DESC,rowid DESC LIMIT 1`).get(target.id) as { id: string } | undefined;
      if (row) this.deps.launcherQueue.kill(row.id);
    }
    this.deps.lifecycleLog?.record({ agentId: target.id, projectId: target.projectId, actorId,
      kind: 'removed', summary: target.pending ? 'Pending agent reservation was withdrawn.' :
        'Agent was removed from the hive.', source: 'server' });
    const work = tasks.closeForRemovedAgent(target);
    if (target.role === "brain") adaptiveTopology.closeBrainExecutions(target);
    const general = target.projectId ? channels.generalChannelId(target.projectId) : null;
    if (general) {
      const notes = [
        work.cancelled ? `${plural(work.cancelled, "unfinished task", "unfinished tasks")} assigned to ${target.name} cancelled` : "",
        work.unreviewed ? `${plural(work.unreviewed, "task", "tasks")} ${target.name} assigned stay open: their workers can still report and submit, but ${target.name} will not review` : "",
      ].filter(Boolean);
      messages.postSystem(general, `${note}${notes.length ? ` ${notes.join("; ")}.` : ""}`);
    }
    storage.afterCommit(() => bus.emit("project", { removed: target.name }));
    return identity.getAgent(target.id);
  }

  /** Inside the project-deletion transaction: deletes the project's agents with their memberships and state. */
  purgeProjectAgents(agentIds: string[]): void {
    for (const id of agentIds) {
      this.detach(id);
      this.db.prepare("DELETE FROM reactions WHERE agent_id = ?").run(id);
      this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    }
  }

  /** Stops everything that reaches the agent: memberships (hence mail), subscriptions, drafts and its wait. */
  private detach(agentId: string): void {
    for (const table of ["channel_members", "reads", "notification_subscriptions"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(agentId);
    }
    this.db.prepare("DELETE FROM upload_reservations WHERE actor_id = ?").run(agentId);
    this.deps.files.deleteUnsentBy(agentId);
    this.deps.storage.afterCommit(() => this.deps.waiters.evict(agentId));
  }

  /** Removes blobs only dropped drafts referenced; a failure leaves them to the next sweep. */
  sweepBlobs(): void {
    try {
      this.deps.files.collectUnusedBlobs();
    } catch {
      /* sweep can drop leftover blobs later */
    }
  }
}
