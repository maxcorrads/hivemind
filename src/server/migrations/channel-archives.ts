import type { DatabaseSync } from 'node:sqlite';

type LegacyContract = { purpose?: string; rules?: string[]; limits?: string[]; completion?: string[];
  participants?: Array<string | { name: string; boundary?: string }>; coordinator: string; instructions?: string };

/** Folds the structured text fields of an older contract into one brief; the enforced fields are kept. */
export function simpleContract(old: LegacyContract): { instructions: string; coordinator: string; participants: string[] } {
  const participants = (old.participants ?? []).map(p => typeof p === 'string' ? p : p.name);
  if (old.instructions !== undefined) return { instructions: old.instructions, coordinator: old.coordinator, participants };
  const list = (title: string, items: string[] | undefined) => items?.length ? [`${title}:`, ...items.map(i => `- ${i}`)] : [];
  const boundaries = (old.participants ?? []).flatMap(p => typeof p !== 'string' && p.boundary ? [`${p.name}: ${p.boundary}`] : []);
  const instructions = [old.purpose ?? '', ...list('Rules', old.rules), ...list('Limits', old.limits),
    ...list('Worker boundaries', boundaries), ...list('Completion', old.completion)].filter(Boolean).join('\n').slice(0, 4000);
  return { instructions: instructions || 'No instructions.', coordinator: old.coordinator, participants };
}

function simpleRoom(snapshot: string): string {
  const { summarySeq: _summary, archivedRunning: _running, ...room } = JSON.parse(snapshot) as Record<string, unknown> & { contract?: LegacyContract };
  return JSON.stringify(room.contract ? { ...room, contract: simpleContract(room.contract) } : room);
}

/**
 * Archive state for every public/private channel (a contract room mirrors it in its snapshot), the
 * Human's auto-archive policy for task channels, and room contracts reduced to one instructions text plus coordinator and participant names.
 */
export function channelArchives(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS channel_archives (
    channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    archived_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS archive_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    auto_archive_task_channels INTEGER NOT NULL DEFAULT 0 CHECK (auto_archive_task_channels IN (0, 1))
  );
  INSERT OR IGNORE INTO channel_archives(channel_id, archived_at)
    SELECT channel_id, COALESCE(json_extract(snapshot,'$.updatedAt'), 0) FROM rooms WHERE json_extract(snapshot,'$.state')='archived';`);
  const rooms = db.prepare('SELECT channel_id, snapshot FROM rooms').all() as Array<{ channel_id: string; snapshot: string }>;
  const updateRoom = db.prepare('UPDATE rooms SET snapshot=? WHERE channel_id=?');
  for (const row of rooms) updateRoom.run(simpleRoom(row.snapshot), row.channel_id);
  const events = db.prepare('SELECT actor_id, request_id, snapshot FROM room_events').all() as Array<{ actor_id: string; request_id: string; snapshot: string }>;
  const updateEvent = db.prepare('UPDATE room_events SET snapshot=? WHERE actor_id=? AND request_id=?');
  for (const row of events) updateEvent.run(simpleRoom(row.snapshot), row.actor_id, row.request_id);
}
