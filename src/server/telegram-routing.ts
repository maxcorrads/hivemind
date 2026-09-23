import type { DatabaseSync } from "node:sqlite";
import { Storage } from "./storage.ts";

// The routing migration is schema work, so it lives with the other migrations.
export { initTelegramRouting } from "./migrations/telegram-routing.ts";

/** Bind a verified provider identity without moving live state or depending on token spelling. */
export function namespaceForVerifiedBot(db: DatabaseSync, botId: number, preferred?: string): string {
  return Storage.for(db).transaction(() => {
    const found = db.prepare("SELECT namespace FROM telegram_bot_identities WHERE bot_id = ?").get(botId) as { namespace: string } | undefined;
    if (found) return found.namespace;
    const namespace = preferred ?? `bot:${botId}`;
    db.prepare("INSERT INTO telegram_bot_identities(bot_id, namespace) VALUES(?, ?)").run(botId, namespace);
    return namespace;
  });
}
