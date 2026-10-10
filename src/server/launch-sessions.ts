import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HiveError, type Agent } from '../shared/types.ts';
import { validated } from '../shared/api-contract.ts';
import { launchSettingsSchema, launchTicketSchema, type LaunchSettings, type SavedLaunch } from '../shared/launch-settings.ts';
import { nativeSessionId, type NativeSession } from '../shared/native-session.ts';
import { softwareFamily } from '../shared/launch-prompt.ts';
import { LauncherQueueCipher } from './launcher-queue-crypto.ts';
import type { Core } from './services/ports.ts';
import type { IdentityService } from './services/identity.ts';

type Row = { id: string; ticket_hash: string; project_id: string; expected_agent_id: string | null;
  previous_launch_id: string | null; previous_session_fingerprint: string | null;
  agent_id: string | null; settings: string; provider: string; session_id: string | null; captured: number;
  created_at: number; bound_at: number | null };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const MAX_AGE = 24 * 60 * 60 * 1000;

/** Only Human's launcher and the approved task queue create executable configuration.
 * The narrowly scoped ticket can report a session ID and bind ONE joining identity, never change settings.
 */
export class LaunchSessions {
  private readonly cipher: LauncherQueueCipher;
  constructor(private readonly deps: Core & { home: string; identity: Pick<IdentityService, 'sessionFingerprint'> }) {
    this.cipher = new LauncherQueueCipher(deps.home,
      Boolean(deps.storage.db.prepare('SELECT 1 FROM launch_sessions LIMIT 1').get() ||
        deps.storage.db.prepare("SELECT 1 FROM launcher_commands WHERE state IN ('queued','dispatched') LIMIT 1").get()));
    for (const row of deps.storage.db.prepare('SELECT settings FROM launch_sessions').all() as { settings: string }[])
      validated(launchSettingsSchema, this.cipher.open(row.settings));
  }
  private get db() { return this.deps.storage.db; }

  prepare(projectId: string, settings: LaunchSettings, expectedAgentId: string | null, nativeId?: string) {
    settings = validated(launchSettingsSchema, settings);
    const provider = softwareFamily(settings.software);
    if (nativeId && !['codex', 'claude', 'cursor'].includes(provider)) throw new HiveError(400, 'This client has no native resume adapter');
    const sessionId = nativeId ? nativeSessionId(nativeId, provider as NativeSession['software'])
      : provider === 'claude' ? randomUUID() : null;
    const id = randomUUID(), ticket = `hml_${randomBytes(32).toString('hex')}`;
    // Unexecuted previews/copies are disposable; never prune a bound employee's current settings.
    this.db.prepare('DELETE FROM launch_sessions WHERE agent_id IS NULL AND created_at < ?').run(Date.now() - MAX_AGE);
    const previous = expectedAgentId ? this.db.prepare('SELECT launch_id FROM agent_launch_settings WHERE agent_id=?').get(expectedAgentId)?.launch_id ?? null : null;
    const fingerprint = expectedAgentId ? this.deps.identity.sessionFingerprint(expectedAgentId) ?? null : null;
    this.db.prepare(`INSERT INTO launch_sessions(id,ticket_hash,project_id,expected_agent_id,previous_launch_id,previous_session_fingerprint,settings,provider,session_id,captured,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, hash(ticket), projectId, expectedAgentId, previous, fingerprint, this.cipher.seal(settings), provider,
      sessionId, provider === 'claude' || !['codex', 'cursor'].includes(provider) ? 1 : 0, Date.now());
    return { ticket, sessionId };
  }

  private ticket(value: unknown): Row {
    const ticket = validated(launchTicketSchema, value);
    const row = this.db.prepare('SELECT * FROM launch_sessions WHERE ticket_hash=?').get(hash(ticket)) as Row | undefined;
    if (!row || !row.agent_id && row.created_at + MAX_AGE < Date.now()) throw new HiveError(409, 'Launch expired; launch again from Hivemind');
    return row;
  }

  capture(ticket: string, value: string): void {
    const row = this.ticket(ticket);
    if (!['codex', 'cursor'].includes(row.provider)) throw new HiveError(400, 'This launch does not accept session callbacks');
    let id: string;
    try { id = nativeSessionId(value, row.provider as NativeSession['software']); }
    catch { throw new HiveError(400, 'Invalid conversation ID'); }
    if (row.session_id && row.session_id !== id) throw new HiveError(409, 'Conversation ID does not match this launch');
    if (row.agent_id) {
      if (row.session_id === id) return;
      throw new HiveError(409, 'Launch is already bound');
    }
    this.db.prepare('UPDATE launch_sessions SET session_id=?,captured=1 WHERE id=?').run(id, row.id);
  }

  projectId(ticket: string): string { return this.ticket(ticket).project_id; }

  /** Validate before joining, then bind in the SAME transaction as identity.join. */
  forJoin(ticket: string, input: { role: string; project?: string | null }, projectId: string,
    candidate: Agent | null, authenticatedId: string | null): { row: Row; settings: LaunchSettings; nativeSession?: NativeSession } {
    const row = this.ticket(ticket), settings = this.cipher.open<LaunchSettings>(row.settings);
    if (row.project_id !== projectId || settings.role !== input.role ||
      row.expected_agent_id && candidate && row.expected_agent_id !== candidate.id ||
      !row.expected_agent_id && candidate && row.agent_id !== candidate.id)
      throw new HiveError(409, 'Launch does not match the joining identity/project');
    // A restarted MCP process no longer holds its in-memory bearer key. Allow an
    // explicit name-based reconnect to this launch's ONE identity, using the same
    // session fencing and lifecycle checks as ordinary resume. A fresh join (no
    // candidate), another identity or a superseded launch still fails closed.
    if (row.agent_id && (row.agent_id !== (authenticatedId ?? candidate?.id) ||
      this.db.prepare('SELECT launch_id FROM agent_launch_settings WHERE agent_id=?').get(row.agent_id)?.launch_id !== row.id))
      throw new HiveError(409, 'Launch already used or superseded; prepare a new Resume');
    // The optional saved-launch pointer is not a session generation: it stays
    // null for legacy/manual joins and stays unchanged during MCP reconnects.
    // Check the session too, before identity.join can rotate its key. Pending
    // pre-migration commands have no fingerprint and must be prepared again.
    if (!row.agent_id && row.expected_agent_id && (!row.previous_session_fingerprint ||
      this.deps.identity.sessionFingerprint(row.expected_agent_id) !== row.previous_session_fingerprint ||
      (this.db.prepare('SELECT launch_id FROM agent_launch_settings WHERE agent_id=?').get(row.expected_agent_id)?.launch_id ?? null) !== row.previous_launch_id))
      throw new HiveError(409, 'Employee resumed since this command was prepared; prepare a new Resume');
    if (!row.captured) throw new HiveError(409, 'Conversation ID not captured. Review the native session hook/CLI configuration, then retry join; do not guess an ID.');
    const nativeSession = ['codex', 'claude', 'cursor'].includes(row.provider)
      ? { software: row.provider as NativeSession['software'], sessionId: row.session_id,
        model: settings.model, effort: settings.effort as NativeSession['effort'] } : undefined;
    return { row, settings, nativeSession };
  }

  bind(id: string, agent: Agent): void {
    const row = this.db.prepare('SELECT * FROM launch_sessions WHERE id=?').get(id) as Row;
    if (row.project_id !== agent.projectId || row.expected_agent_id && row.expected_agent_id !== agent.id)
      throw new HiveError(409, 'Launch does not match this identity');
    this.db.prepare('UPDATE launch_sessions SET agent_id=?,bound_at=? WHERE id=?').run(agent.id, Date.now(), id);
    this.db.prepare(`INSERT INTO agent_launch_settings(agent_id,launch_id) VALUES (?,?)
      ON CONFLICT(agent_id) DO UPDATE SET launch_id=excluded.launch_id`).run(agent.id, id);
  }

  saved(agentId: string): SavedLaunch | null {
    const row = this.db.prepare(`SELECT s.* FROM launch_sessions s JOIN agent_launch_settings a ON a.launch_id=s.id
      WHERE a.agent_id=?`).get(agentId) as Row | undefined;
    return row ? { settings: validated(launchSettingsSchema, this.cipher.open(row.settings)),
      sessionId: row.session_id, captured: Boolean(row.captured) } : null;
  }

  forget(agentId: string): void { this.db.prepare('DELETE FROM agent_launch_settings WHERE agent_id=?').run(agentId); }
}
