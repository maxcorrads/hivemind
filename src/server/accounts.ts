import { z } from "zod";
import { HiveError, type Agent } from "../shared/types.ts";
import {
  ACCOUNT_DRIVERS, ACCOUNT_ERRORS, ACCOUNT_LIMITS, ACCOUNT_POLICIES, accountSpecSchema,
  type AccountDriver, type AccountPolicies, type AccountPolicy, type AccountSpec, type AccountUsage, type AgentAccount,
} from "../shared/accounts.ts";
import { selectAccount, type AccountSelection } from "../shared/account-selection.ts";
import type { Core } from "./services/ports.ts";

type Row = {
  id: string; driver: AccountDriver; label: string; position: number; home_path: string; shadow_path: string;
  revision: number; last_selected_at: number | null; created_at: number; updated_at: number;
};

type Catalog = { accounts: AgentAccount[]; policies: AccountPolicies };

/** The revision the edit started from; `driver` is accepted only so that changing it is refused with a reason. */
const updateAccountSchema = z.object({
  expectedRevision: z.number().int().positive(),
  driver: z.enum(ACCOUNT_DRIVERS).optional(),
  label: z.string().optional(),
  homePath: z.string().optional(),
  shadowPath: z.string().optional(),
}).strict();

/** Field paths and reasons, never values: a label or path is the account's own text. */
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const reasons = result.error.issues.slice(0, 6).map(issue => `${issue.path.join(".") || "body"}: ${issue.message}`);
  throw new HiveError(400, `Invalid account: ${reasons.join("; ")}`);
}

/**
 * Human-only catalog of the named Codex and Claude accounts (docs/accounts.md): order, paths and policy, with revision
 * checks. Paths are checked by accountSpecSchema, which applies accountPathProblem to both.
 */
export class AccountStore {
  /** `usage` supplies each account's latest usage; until phase 5 there is none, so every account reads as unknown. */
  constructor(private readonly deps: Core, private readonly usage: () => ReadonlyMap<string, AccountUsage> = () => new Map()) {}

  private get db() { return this.deps.storage.db; }

  private view(row: Row): AgentAccount {
    return { id: row.id, driver: row.driver, label: row.label, homePath: row.home_path, shadowPath: row.shadow_path,
      command: row.driver, order: row.position, revision: row.revision, lastSelectedAt: row.last_selected_at,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private human(actor: Agent) {
    if (actor.role !== "human") throw new HiveError(403, "Only Human manages accounts");
  }

  private row(id: string): Row {
    const row = this.db.prepare("SELECT * FROM agent_accounts WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError(404, "Account not found");
    return row;
  }

  private changed() {
    this.deps.storage.afterCommit(() => this.deps.bus.emit("accounts", {}));
  }

  private count(driver: AccountDriver): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM agent_accounts WHERE driver = ?").get(driver) as { n: number }).n);
  }

  /** Label unique per driver, shadow unique across the catalog, one primary per driver and home: 409 each. */
  private assertUnique(spec: AccountSpec, except: string | null) {
    if (this.db.prepare("SELECT 1 FROM agent_accounts WHERE driver = ? AND label = ? AND id IS NOT ?").get(spec.driver, spec.label, except))
      throw new HiveError(409, `Another ${spec.driver} account already uses this label`);
    if (spec.shadowPath && this.db.prepare("SELECT 1 FROM agent_accounts WHERE shadow_path = ? AND id IS NOT ?").get(spec.shadowPath, except))
      throw new HiveError(409, "Another account already uses this shadowPath");
    if (!spec.shadowPath && this.db.prepare("SELECT 1 FROM agent_accounts WHERE driver = ? AND home_path = ? AND shadow_path = '' AND id IS NOT ?")
      .get(spec.driver, spec.homePath, except))
      throw new HiveError(409, "Another primary account already uses this homePath");
  }

  get(id: string): AgentAccount {
    return this.view(this.row(id));
  }

  list(): Catalog {
    const rows = this.db.prepare("SELECT * FROM agent_accounts ORDER BY driver, position").all() as Row[];
    // A driver without a policy row is sequential.
    const policies: AccountPolicies = { codex: "sequential", claude: "sequential" };
    for (const row of this.db.prepare("SELECT driver, policy FROM agent_account_policies").all() as { driver: AccountDriver; policy: AccountPolicy }[]) {
      policies[row.driver] = row.policy;
    }
    return { accounts: rows.map(row => this.view(row)), policies };
  }

  create(actor: Agent, raw: unknown): AgentAccount {
    this.human(actor);
    const input = parse(accountSpecSchema, raw);
    return this.deps.storage.transaction(() => {
      const position = this.count(input.driver);
      if (position >= ACCOUNT_LIMITS.perDriver) throw new HiveError(429, `A driver has at most ${ACCOUNT_LIMITS.perDriver} accounts`);
      this.assertUnique(input, null);
      const id = crypto.randomUUID(), at = Date.now();
      this.db.prepare("INSERT INTO agent_accounts (id, driver, label, position, home_path, shadow_path, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
        .run(id, input.driver, input.label, position, input.homePath, input.shadowPath, at, at);
      this.changed();
      return this.get(id);
    });
  }

  update(actor: Agent, id: string, raw: unknown): AgentAccount {
    this.human(actor);
    const input = parse(updateAccountSchema, raw);
    return this.deps.storage.transaction(() => {
      const row = this.row(id);
      if (input.driver !== undefined && input.driver !== row.driver) throw new HiveError(400, "An account's driver cannot change");
      if (row.revision !== input.expectedRevision) throw new HiveError(409, "The account changed; reload it before saving");
      const spec = parse(accountSpecSchema, { driver: row.driver, label: input.label ?? row.label,
        homePath: input.homePath ?? row.home_path, shadowPath: input.shadowPath ?? row.shadow_path });
      this.assertUnique(spec, id);
      this.db.prepare("UPDATE agent_accounts SET label = ?, home_path = ?, shadow_path = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(spec.label, spec.homePath, spec.shadowPath, Date.now(), id);
      this.changed();
      return this.get(id);
    });
  }

  delete(actor: Agent, id: string, expectedRevision: number): void {
    this.human(actor);
    this.deps.storage.transaction(() => {
      const row = this.row(id);
      if (row.revision !== expectedRevision) throw new HiveError(409, "The account changed; reload it before deleting");
      const pinned = this.db.prepare("SELECT slug, json_extract(spec, '$.label') AS label FROM worker_templates WHERE json_extract(spec, '$.accountId') = ? ORDER BY slug")
        .all(id) as { slug: string; label: string | null }[];
      // HiveError carries only a message, so the code leads it.
      if (pinned.length > 0) throw new HiveError(409, `${ACCOUNT_ERRORS.pinned}: worker templates ${pinned.map(template => template.label ?? template.slug).join(", ")} pin this account; unpin them first`);
      this.db.prepare("DELETE FROM agent_accounts WHERE id = ?").run(id);
      // Closes the gap: each later account moves up one place and bumps its revision, as a reorder does.
      this.db.prepare("UPDATE agent_accounts SET position = position - 1, revision = revision + 1, updated_at = ? WHERE driver = ? AND position > ?")
        .run(Date.now(), row.driver, row.position);
      this.changed();
    });
  }

  /** `ids` must name every account of the driver exactly once: 0…n−1 becomes the new order. */
  reorder(actor: Agent, driver: AccountDriver, ids: string[]): Catalog {
    this.human(actor);
    return this.deps.storage.transaction(() => {
      const known = (this.db.prepare("SELECT id FROM agent_accounts WHERE driver = ?").all(driver) as { id: string }[]).map(row => row.id);
      const wanted = new Set(ids);
      if (!ACCOUNT_DRIVERS.includes(driver) || wanted.size !== ids.length || ids.length !== known.length || !known.every(id => wanted.has(id)))
        throw new HiveError(400, `Reorder must name every ${driver} account exactly once`);
      const at = Date.now();
      const move = this.db.prepare("UPDATE agent_accounts SET position = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND position <> ?");
      ids.forEach((id, position) => move.run(position, at, id, position));
      this.changed();
      return this.list();
    });
  }

  setPolicy(actor: Agent, driver: AccountDriver, policy: AccountPolicy): Catalog {
    this.human(actor);
    if (!ACCOUNT_DRIVERS.includes(driver) || !ACCOUNT_POLICIES.includes(policy)) throw new HiveError(400, "Policy must be sequential or balanced for codex or claude");
    return this.deps.storage.transaction(() => {
      this.db.prepare(`INSERT INTO agent_account_policies (driver, policy, revision, updated_at) VALUES (?, ?, 1, ?)
        ON CONFLICT (driver) DO UPDATE SET policy = excluded.policy, revision = revision + 1, updated_at = excluded.updated_at`)
        .run(driver, policy, Date.now());
      this.changed();
      return this.list();
    });
  }

  /**
   * The account a launch of `driver` uses: the pin when one is given, else the driver's policy (docs/accounts.md). With
   * `record`, the chosen account counts as selected, so balanced round-robin moves on to the next one.
   */
  resolve(actor: Agent, input: { driver: AccountDriver; accountId?: string | null; record?: boolean }, now: number): AccountSelection {
    this.human(actor);
    const catalog = this.list();
    const selection = selectAccount({ accounts: catalog.accounts.filter(account => account.driver === input.driver),
      policy: catalog.policies[input.driver], usage: this.usage(), now, pin: input.accountId ?? null });
    if (input.record && selection.kind === "account") this.markSelected(selection.account.id, now);
    return selection;
  }

  /** Internal: a launch picked this account. Emits no event, since Human did not change anything. */
  markSelected(id: string, now: number): void {
    this.db.prepare("UPDATE agent_accounts SET last_selected_at = ? WHERE id = ?").run(now, id);
  }
}
