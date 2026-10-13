import type { DatabaseSync } from "node:sqlite";

/**
 * The unread counts and For you (ReadState) walk every unread message of the visible channels by channel and seq.
 * `idx_messages_channel_seq` finds them, but each row then has to be read from the table, body pages and all, for its
 * author, thread, mentions and recipients: with tens of thousands unread that is most of the server's time. This
 * index carries those columns, so the walk never leaves it.
 */
export function messageUnreadCoverIndex(db: DatabaseSync): void {
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_unread_cover ON messages(channel_id, seq, author_id, thread_id, id, mentions, recipients)");
}
