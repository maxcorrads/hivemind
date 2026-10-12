import type { DatabaseSync } from "node:sqlite";

/**
 * For you's "thread" reason asks, for each reply, whether the reader wrote an earlier message in its thread. With only
 * `idx_messages_thread` that reads the row of every earlier reply, so a thread of n replies costs n²/2 rows on each
 * snapshot; this index answers each question with one seek.
 */
export function messageThreadAuthorIndex(db: DatabaseSync): void {
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_thread_author_seq ON messages(thread_id, author_id, seq)");
}
