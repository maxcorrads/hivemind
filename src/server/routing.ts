import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Hive } from './hive.ts';
import type { Agent } from '../shared/types.ts';
import { HiveError } from '../shared/types.ts';
import { validated } from '../shared/api-contract.ts';
import { immediateTransaction } from './transaction.ts';
import { ROUTING_LIMITS, setCapabilitiesSchema, suggestWorkersSchema, routingOutcomeSchema, routingOverrideSchema,
  outcomeInterval, type CapabilityCard, type CapabilityView, type RoutingSuggestions, type WorkerSuggestion } from '../shared/routing.ts';

/** Opt-in declarations and limited, explicitly classified review evidence; never an assignment engine. */
export class RoutingStore {
  constructor(private hive: Hive) {
    hive.db.exec(`CREATE TABLE IF NOT EXISTS worker_capabilities (
      worker_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, configuration TEXT NOT NULL, card TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS capabilities_project ON worker_capabilities(project_id, worker_id);
      CREATE TABLE IF NOT EXISTS routing_outcomes (
        task_id TEXT PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        worker_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        review_revision INTEGER NOT NULL, category TEXT NOT NULL, configuration TEXT NOT NULL,
        accepted INTEGER NOT NULL, recorded_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS routing_evidence ON routing_outcomes(worker_id, category, configuration, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS routing_project_retention ON routing_outcomes(project_id, recorded_at);`);
  }
  private get db() { return this.hive.db; }
  private configuration(card: CapabilityCard) {
    return createHash('sha256').update(JSON.stringify([card.model, card.host,
      [...card.capabilities].sort(), [...card.modes].sort(), card.availableContext])).digest('hex');
  }
  private worker(actor: Agent, id: string) {
    validated(z.string().uuid(), id);
    const worker = this.hive.getAgent(id);
    if (worker.role !== 'worker' || (actor.role !== 'human' && actor.projectId !== worker.projectId) || actor.role === 'bot')
      throw new HiveError(403, 'Worker capability is unavailable in this scope');
    if (actor.role === 'worker' && actor.id !== id) throw new HiveError(403, 'Workers can read only their own capability card');
    return worker;
  }
  get(actor: Agent, id: string): CapabilityView | null {
    this.worker(actor, id);
    const row = this.db.prepare('SELECT revision, updated_at, card FROM worker_capabilities WHERE worker_id = ?')
      .get(id) as { revision: number; updated_at: number; card: string } | undefined;
    return row ? { workerId: id, revision: row.revision, updatedAt: row.updated_at, card: JSON.parse(row.card) as CapabilityCard } : null;
  }
  set(actor: Agent, raw: unknown): CapabilityView {
    if (actor.role !== 'worker' || !actor.projectId) throw new HiveError(403, 'Only a worker can opt in with its own capability card');
    const input = validated(setCapabilitiesSchema, raw);
    return immediateTransaction(this.db, () => {
      const previous = this.get(actor, actor.id);
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new HiveError(409, 'Capability changed; read its revision before saving');
      const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM worker_capabilities WHERE project_id = ?').get(actor.projectId)!.n);
      if (!previous && count >= ROUTING_LIMITS.cards) throw new HiveError(429, 'Project capability-card budget reached');
      const revision = (previous?.revision ?? 0) + 1, at = Date.now();
      this.db.prepare(`INSERT INTO worker_capabilities VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET revision=excluded.revision, updated_at=excluded.updated_at,
          configuration=excluded.configuration, card=excluded.card`)
        .run(actor.id, actor.projectId, revision, at, this.configuration(input.card), JSON.stringify(input.card));
      return { workerId: actor.id, revision, updatedAt: at, card: input.card };
    });
  }
  private task(actor: Agent, id: string) {
    if (actor.role !== 'brain' && actor.role !== 'human') throw new HiveError(403, 'Only Human or a brain can inspect routing');
    validated(z.string().uuid(), id);
    return this.hive.tasks.get(actor, id);
  }
  recordOutcome(actor: Agent, id: string, raw: unknown) {
    const input = validated(routingOutcomeSchema, raw);
    return immediateTransaction(this.db, () => {
      const task = this.task(actor, id);
      if (actor.id !== task.assignerId || actor.role !== 'brain') throw new HiveError(403, 'Only the assigning reviewer can classify a task outcome');
      if (task.revision !== input.expectedRevision) throw new HiveError(409, 'Task revision changed');
      if (!task.review || !['accepted_complete', 'changes_requested'].includes(task.state)) throw new HiveError(409, 'An actual assigning-brain review is required');
      const capability = this.get(actor, task.workerId);
      if (!capability || !capability.card.enabled || capability.revision !== input.capabilityRevision) throw new HiveError(409, 'Read the opted-in capability revision and explicitly confirm its declared configuration');
      const configuration = this.configuration(capability.card), project = this.hive.getChannel(task.channelId).projectId;
      const old = this.db.prepare('SELECT review_revision, category, configuration FROM routing_outcomes WHERE task_id = ?').get(id);
      if (old && (old.category !== input.category || old.configuration !== configuration)) throw new HiveError(409, 'An outcome cannot be relabelled as another category or configuration');
      if (old?.review_revision === task.revision) return { recorded: true, duplicate: true };
      const now = Date.now();
      this.db.prepare('DELETE FROM routing_outcomes WHERE project_id = ? AND recorded_at < ?').run(project, now - ROUTING_LIMITS.retentionMs);
      const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM routing_outcomes WHERE project_id = ?').get(project)!.n);
      if (!old && count >= ROUTING_LIMITS.samples) throw new HiveError(429, 'Routing evidence budget reached');
      this.db.prepare(`INSERT INTO routing_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET worker_id=excluded.worker_id, review_revision=excluded.review_revision,
          accepted=excluded.accepted, recorded_at=excluded.recorded_at`)
        .run(id, project, task.workerId, task.revision, input.category, configuration, task.review.decision === 'accepted' ? 1 : 0, now);
      return { recorded: true, duplicate: false };
    });
  }
  suggest(actor: Agent, id: string, raw: unknown): RoutingSuggestions {
    const input = validated(suggestWorkersSchema, raw), task = this.task(actor, id);
    const channel = this.hive.getChannel(task.channelId), project = channel.projectId;
    const rows = this.db.prepare(`SELECT c.worker_id, c.revision, c.card, c.configuration, a.name FROM worker_capabilities c
      JOIN agents a ON a.id = c.worker_id WHERE c.project_id = ? AND a.project_id = ? AND a.role = 'worker'
      ORDER BY c.worker_id LIMIT ?`).all(project, project, ROUTING_LIMITS.cards + 1) as
      Array<{ worker_id: string; revision: number; card: string; configuration: string; name: string }>;
    if (rows.length > ROUTING_LIMITS.cards) throw new HiveError(429, 'Legacy capability roster exceeds budget');
    const candidates: WorkerSuggestion[] = [];
    for (const row of rows) {
      const card = JSON.parse(row.card) as CapabilityCard;
      const worker = this.hive.getAgent(row.worker_id);
      if (!card.enabled || card.availability === 'unavailable' || !card.modes.includes(input.mode) ||
        !input.requiredCapabilities.every(tag => card.capabilities.includes(tag)) ||
        (input.minContext !== undefined && (card.availableContext === null || card.availableContext < input.minContext)) ||
        (input.mode === 'review' && task.workerId === worker.id) ||
        !this.hive.canSeeChannel(worker, channel) || !this.hive.canPost(worker, channel)) continue;
      // Caller-visible evidence only, not private task metadata or a cross-project score.
      const evidence = this.db.prepare(`SELECT o.accepted FROM routing_outcomes o JOIN task_records r ON r.id=o.task_id
        JOIN channels c ON c.id=r.channel_id WHERE o.project_id=? AND o.worker_id=? AND o.category=? AND o.configuration=?
          AND r.worker_id=o.worker_id AND json_extract(r.snapshot,'$.revision')=o.review_revision
          AND o.recorded_at>=? AND (?='human' OR EXISTS(SELECT 1 FROM channel_members m WHERE m.channel_id=c.id AND m.agent_id=?))
        ORDER BY o.recorded_at DESC, o.task_id LIMIT ?`).all(project, worker.id, input.category, row.configuration,
          Date.now() - ROUTING_LIMITS.retentionMs, actor.role, actor.id, ROUTING_LIMITS.evidence) as Array<{ accepted: number }>;
      const accepted = evidence.reduce((n, e) => n + e.accepted, 0), interval = outcomeInterval(accepted, evidence.length);
      if (evidence.length < (input.minReviewedResults ?? 0) ||
        (input.minimumAcceptedRate !== undefined && (!interval || interval[0] < input.minimumAcceptedRate))) continue;
      const workload = this.db.prepare(`SELECT COUNT(*) AS n FROM task_records r JOIN channels c ON c.id=r.channel_id
        WHERE c.project_id=? AND r.worker_id=? AND r.id!=? AND json_extract(r.snapshot,'$.state') NOT IN ('accepted_complete','rejected')
          AND (?='human' OR EXISTS(SELECT 1 FROM channel_members m WHERE m.channel_id=c.id AND m.agent_id=?))`)
        .get(project, worker.id, task.id, actor.role, actor.id) as { n: number };
      if (workload.n >= card.maxInProgress) continue;
      candidates.push({ workerId: worker.id, name: row.name, capabilityRevision: row.revision, card,
        visibleInProgress: workload.n, workloadIncomplete: actor.role !== 'human', providerCost: null,
        evidence: { reviewed: evidence.length, accepted, acceptedRate: evidence.length ? accepted / evidence.length : null,
          interval95: interval, basis: 'Caller-visible, reviewer-classified outcomes for the declared configuration and category; not independent verification of runtime model or code quality.' },
        reasons: [`Declared capabilities match: ${input.requiredCapabilities.join(', ') || 'no capabilities required'}`,
          `Declared ${card.availability}; ${workload.n} other visible unfinished tasks. Confirm capacity with the worker.`,
          evidence.length ? `${accepted}/${evidence.length} classified reviews; small and selected samples are not general ability.` : 'Cold start: no matching evidence, not excluded by default.',
          input.mode === 'review' ? 'Not the implementation worker; separate review is still required.' : 'No implicit task assignment.'] });
    }
    // Do not reward a worker for having received only easy tasks or exclude a cold start by default.
    candidates.sort((a, b) => Number(a.card.availability !== 'available') - Number(b.card.availability !== 'available') ||
      a.visibleInProgress - b.visibleInProgress || a.name.localeCompare(b.name));
    const offset = input.offset ?? 0;
    return { taskId: id, taskRevision: task.revision, category: input.category, candidates: candidates.slice(offset, offset + ROUTING_LIMITS.page),
      eligibleTotal: candidates.length, consideredCards: rows.length, nextOffset: offset + ROUTING_LIMITS.page < candidates.length ? offset + ROUTING_LIMITS.page : null,
      warning: 'Advisory snapshot only. Declarations and selected review samples are not verified capability, availability, model identity or cost. Private workload/evidence is not disclosed; reread before assigning. No terminal/model is started or changed.',
      delegationAdvice: 'Consider not delegating small or tightly coupled work. No workload-specific break-even threshold has been measured; use the evaluation harness before claiming a gain.' };
  }
  override(actor: Agent, id: string, raw: unknown) {
    const input = validated(routingOverrideSchema, raw), task = this.task(actor, id);
    if (actor.role !== 'human' && actor.id !== task.assignerId) throw new HiveError(403, 'Only Human or the assigning brain may record a routing override');
    if (task.revision !== input.expectedRevision) throw new HiveError(409, 'Task changed; reread before recording a choice');
    const worker = this.worker(actor, input.workerId), channel = this.hive.getChannel(task.channelId);
    if (worker.projectId !== channel.projectId || !this.hive.canSeeChannel(worker, channel)) throw new HiveError(403, 'Selected worker lacks task-channel access');
    const message = this.hive.postMessage(actor, { channel: task.channelId, threadId: task.id,
      requestId: 'routing-' + createHash('sha256').update(input.requestId).digest('hex'), eventType: 'decision',
      body: `Advisory routing choice: ${worker.name}\nTask revision ${task.revision}\nReason: ${input.reason}\nThis records a preference only; task ownership, claims, contract and running terminals are unchanged.` });
    return { message, assigned: false };
  }
}
