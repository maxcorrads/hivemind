import { validated, waitDurationSchema } from "../../shared/api-contract.ts";
import {
  DEFAULT_WAIT_MS,
  HiveError,
  HUMAN_ID,
  WAIT_SCAN_MAX,
  type Agent,
  type Channel,
  type InboxStatus,
  type Message,
  type QueueEstimate,
  type WaitResult,
} from "../../shared/types.ts";
import type { InboxDeliveryStore } from "../inbox-delivery.ts";
import type { InboxReader } from "../inbox-reader.ts";
import type { TaskStore } from "../tasks.ts";
import type { TimelineStore } from "../timeline.ts";
import { packWait } from "../wait-format.ts";
import type { AgentDirectory, Core } from "./ports.ts";
import type { Waiter, Waiters } from "./waiters.ts";

export type DeliveryServiceDeps = Core & {
  readonly identity: AgentDirectory & { touch(agentId: string, online?: boolean): void };
  /** Durable inbox sessions and delivery receipts. */
  readonly inbox: InboxDeliveryStore;
  /** Classifies and pages an agent's unseen mail. */
  readonly inboxReader: InboxReader;
  readonly tasks: Pick<TaskStore, "recordReceipt" | "view">;
  readonly timeline: Pick<TimelineStore, "recordAcknowledgement" | "recordOffer">;
  readonly waiters: Waiters;
};

/**
 * Brain/worker inbox delivery: sessions, the long-poll `wait`, acknowledgements,
 * queue estimates and waking the recipients of committed mail.
 */
export class DeliveryService {
  constructor(private readonly deps: DeliveryServiceDeps) {}

  openInboxSession(actor: Agent, sessionId: string): string {
    if (actor.role !== "brain" && actor.role !== "worker") throw new HiveError(403, "Only agents have inbox sessions");
    const previous = this.deps.inbox.currentSession(actor.id);
    const current = this.deps.inbox.openSession(actor.id, sessionId);
    if (previous !== current) this.deps.waiters.supersede(actor.id);
    return current;
  }

  acknowledgeInbox(actor: Agent, sessionId: string, deliveryId: string) {
    if (actor.role !== "brain" && actor.role !== "worker") throw new HiveError(403, "Only agents acknowledge inbox mail");
    let changed: string[] = [];
    const result = this.deps.inbox.acknowledge(actor.id, sessionId, deliveryId,
      (seqs, at) => { changed = this.deps.tasks.recordReceipt(actor.id, seqs, at); });
    this.deps.timeline.recordAcknowledgement(actor, deliveryId, result.acknowledgedAt);
    for (const id of changed) this.deps.bus.emit('task', this.deps.tasks.view(this.deps.identity.getAgent(HUMAN_ID), id));
    this.emitQueued(actor.id);
    return result;
  }

  inboxStatuses(): Record<string, InboxStatus> {
    return Object.fromEntries(
      this.deps.identity.listAgents()
        .filter((agent) => agent.role === "brain" || agent.role === "worker")
        .map((agent) => [agent.id, { ...this.deps.inbox.status(agent.id), queued: this.deps.inboxReader.estimate(agent) }]),
    );
  }

  /** Receipt status and queue estimate of every agent, estimating each inbox once (the UI snapshot). */
  queueSnapshot(): { queued: Record<string, number>; inbox: Record<string, InboxStatus> } {
    const inbox = this.inboxStatuses();
    return { inbox, queued: Object.fromEntries(Object.entries(inbox).map(([id, status]) => [id, status.queued?.atLeast ?? 0])) };
  }

  private takeUnseen(actor: Agent, sessionId: string, compact: boolean, scanLimit: number): WaitResult {
    const current = this.deps.identity.getAgent(actor.id);
    const result = this.deps.inboxReader.take(current, sessionId, compact, scanLimit);
    if (result.delivery) this.deps.timeline.recordOffer(current, result.delivery);
    this.emitQueued(actor.id, result.page!.remaining);
    return result;
  }

  queuedCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const agent of this.deps.identity.listAgents()) {
      if (agent.role !== "brain" && agent.role !== "worker") continue;
      out[agent.id] = this.deps.inboxReader.estimate(agent).atLeast;
    }
    return out;
  }

  private emitQueued(agentId: string, estimate?: QueueEstimate) {
    const agent = this.deps.identity.getAgent(agentId);
    if (agent.role !== "brain" && agent.role !== "worker") return;
    const queued = estimate ?? this.deps.inboxReader.estimate(agent);
    this.deps.bus.emit("queued", {
      agentId,
      n: queued.atLeast,
      inbox: { ...this.deps.inbox.status(agentId), queued },
    });
  }

  /** Wait wakes agents only for mail addressed to them, not public chatter. */
  isFor(actor: Agent, msg: Message): boolean {
    return (actor.role === 'brain' || actor.role === 'worker') && this.deps.inboxReader.isFor(actor, msg.seq);
  }

  /** Wakes and re-counts every member (and Human) for whom `msg` is inbox mail. */
  wakeMembers(ch: Channel, msg: Message) {
    for (const id of new Set([...ch.memberIds, HUMAN_ID])) {
      if (id === msg.authorId) continue;
      const agent = this.deps.identity.getAgent(id);
      // The notification classifier rechecks current project, channel membership,
      // role and routing in SQL. Do not hydrate the entire roster for every member.
      if (!this.isFor(agent, msg)) continue;
      this.deps.waiters.wake(id);
      this.emitQueued(id);
    }
  }

  async wait(
    actor: Agent,
    timeoutMs: number,
    signal?: AbortSignal,
    opts: { compact?: boolean; sessionId?: string } = {},
  ): Promise<WaitResult> {
    validated(waitDurationSchema, timeoutMs);
    const compact = Boolean(opts.compact);
    const empty = () => packWait(this.deps.identity.getAgent(actor.id), [], 0, compact, () => "");

    // A cancelled request is observational only: it must not touch presence,
    // install a waiter, advance inbox state, or consume already-queued mail.
    if (actor.role === "bot") throw new HiveError(403, "Bots publish observations; they do not wait for work");

    // No session/presence/cursor side effects for work cancelled before admission.
    if (signal?.aborted) return empty();

    const sessionId =
      opts.sessionId ??
      this.deps.inbox.currentSession(actor.id) ??
      this.openInboxSession(actor, crypto.randomUUID());
    this.deps.inbox.requireSession(actor.id, sessionId);
    this.deps.identity.touch(actor.id, true);

    return new Promise((resolve, reject) => {
      let done = false;
      let scannedRows = 0;
      let hydratedMessages = 0;
      let acknowledgedThroughSeq: number | undefined;
      let routineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = Date.now() + (Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : DEFAULT_WAIT_MS);
      const take = () => {
        const batch = this.takeUnseen(actor, sessionId, compact, WAIT_SCAN_MAX - scannedRows);
        const page = batch.page!;
        scannedRows += page.scannedRows;
        hydratedMessages += page.hydratedMessages;
        acknowledgedThroughSeq ??= page.acknowledgedThroughSeq;
        batch.page = { ...page, scannedRows, hydratedMessages, acknowledgedThroughSeq };
        return batch;
      };
      let waiter: Waiter;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        this.deps.waiters.release(actor.id, waiter);
        signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
        if (routineTimer) clearTimeout(routineTimer);
      };
      const deliver = (batch: WaitResult) => {
        if (done) return;
        done = true;
        cleanup();
        this.deps.identity.touch(actor.id, true);
        resolve(batch);
      };
      const fail = (error: HiveError) => {
        if (done) return;
        done = true;
        cleanup();
        reject(error);
      };
      const finish = (consume: boolean) => {
        if (done) return;
        if (!consume || signal?.aborted) {
          deliver(empty());
          return;
        }
        try {
          clearTimeout(routineTimer);
          const batch = take();
          if (batch.idle && batch.retryAfterMs && Date.now() < deadline && scannedRows < WAIT_SCAN_MAX) {
            routineTimer = setTimeout(() => finish(true), Math.min(batch.retryAfterMs, deadline - Date.now()));
          } else deliver(batch);
        }
        catch (error) { done = true; cleanup(); reject(error); }
      };
      waiter = {
        wake: () => finish(true),
        supersede: () => fail(new HiveError(409, "superseded")),
        interrupt: () => fail(new HiveError(503, "Server is shutting down")),
      };
      const onAbort = () => finish(false);
      this.deps.waiters.install(actor.id, waiter);
      const ms = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : DEFAULT_WAIT_MS;
      timer = setTimeout(() => finish(true), ms);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        finish(false);
        return;
      }
      try {
        const first = take();
        if (!first.idle || first.page!.continuation || scannedRows === WAIT_SCAN_MAX) deliver(first);
        else if (first.retryAfterMs) routineTimer = setTimeout(() => finish(true), Math.min(first.retryAfterMs, ms));
      } catch (error) { done = true; cleanup(); reject(error); }
    });
  }

  /** Interrupts pending waits for shutdown without superseding durable sessions. */
  cancelWaits() {
    this.deps.waiters.interruptAll();
  }
}
