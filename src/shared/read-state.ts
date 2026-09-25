import type { Message } from "./types.ts";

export type ReadStamp = {
  readInstance: string;
  readRevision: number;
  readSeq: number;
};

export type ReadSnapshot = ReadStamp & {
  unread: Record<string, number>;
  /** The newest unread For you messages (see ActivityReason), across projects. */
  mentions: Message[];
  mentionsHasMore: boolean;
  /** Unread For you messages per project slug: the sidebar's For you badge. */
  mentionCounts: Record<string, number>;
};

export type MentionPage = ReadStamp & {
  messages: Message[];
  hasMore: boolean;
};

/**
 * Why a message is For you. `direct`: in a DM with the reader; `mention`: names or
 * addresses the reader; `thread`: a reply after the reader took part in the thread;
 * `task`: a task event addressed to the reader.
 */
export const ACTIVITY_REASONS = ["direct", "mention", "thread", "task"] as const;
export type ActivityReason = typeof ACTIVITY_REASONS[number];

/** One For you entry with its read state from the server. */
export type ActivityItem = {
  message: Message;
  /** Project slug of the message's channel. */
  project: string;
  reason: ActivityReason;
  read: boolean;
};

/** A newest-first page of For you: every entry (Activity) or only the unread ones (Unread). */
export type ActivityPage = ReadStamp & {
  items: ActivityItem[];
  hasMore: boolean;
};
