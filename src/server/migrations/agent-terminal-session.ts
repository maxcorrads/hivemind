import type { DatabaseSync } from "node:sqlite";
import { hasColumn } from "./schema.ts";

/**
 * The tmux session an agent launched from Hivemind runs in (`hm-…`, reported by `hivemind mcp` on join from
 * HIVEMIND_TMUX_SESSION). It is a display label only: nothing on the server runs, opens or kills a terminal by it.
 * Existing agents start without one.
 */
export function agentTerminalSession(db: DatabaseSync): void {
  if (!hasColumn(db, "agents", "terminal_session")) db.exec("ALTER TABLE agents ADD COLUMN terminal_session TEXT");
}
