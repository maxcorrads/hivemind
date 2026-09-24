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
  readonly decisions: { withdrawForRemovedBrain(brain: Agent): number };
  readonly adaptiveTopology: { closeBrainExecutions(brain: Agent): void };
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * How an agent leaves the hive (#215). Both operations run inside one transaction: the caller's (project deletion) or
 * their own (removal). Events and waiter evictions happen only after the commit.
 *
 * - Removal keeps a tombstone: the agent row stays (marked `removed_at`) so its messages, tasks, decisions and routing
 *   outcomes keep their author. The agent can no longer authenticate, join, resume, receive mail or be assigned; its
 *   open work is closed: tasks assigned to it are cancelled, its pending decision requests withdrawn and its Jev
 *   executions completed. Tasks it assigned stay open so their workers can still report and submit.
 * - Project deletion purges: the project's agents are deleted along with everything else the project scoped.
 */
export class AgentLifecycle {
  constructor(private readonly deps: AgentLifecycleDeps) {}

  private get db() { return this.deps.storage.db; }

  removeAgent(actor: Agent, name: string): Agent {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can remove agents");
    const { storage, identity, tasks, decisions, adaptiveTopology, channels, messages, bus } = this.deps;
    const removed = storage.transaction(() => {
      const target = identity.getAgentByName(name);
      if (!target) throw new HiveError(404, `No agent named ${name}`);
      if (target.id === HUMAN_ID || target.role === "human") throw new HiveError(403, "Cannot remove Human");
      this.detach(target.id);
      // Tombstone first, so the task and decision views published below already label the agent as removed.
      identity.markRemoved(target.id, now());
      const work = tasks.closeForRemovedAgent(target);
      const withdrawn = target.role === "brain" ? decisions.withdrawForRemovedBrain(target) : 0;
      if (target.role === "brain") adaptiveTopology.closeBrainExecutions(target);
      const general = target.projectId ? channels.generalChannelId(target.projectId) : null;
      if (general) {
        const notes = [
          work.cancelled ? `${plural(work.cancelled, "unfinished task", "unfinished tasks")} assigned to ${target.name} cancelled` : "",
          withdrawn ? `${plural(withdrawn, "pending decision request", "pending decision requests")} withdrawn` : "",
          work.unreviewed ? `${plural(work.unreviewed, "task", "tasks")} ${target.name} assigned stay open: their workers can still report and submit, but ${target.name} will not review` : "",
        ].filter(Boolean);
        messages.postSystem(general, `${actor.name} removed ${target.name} from the hive.${notes.length ? ` ${notes.join("; ")}.` : ""}`);
      }
      storage.afterCommit(() => bus.emit("project", { removed: target.name }));
      return identity.getAgent(target.id);
    });
    this.sweepBlobs();
    return removed;
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
