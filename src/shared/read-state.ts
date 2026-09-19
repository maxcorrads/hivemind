import type { Message } from "./types.ts";

export type ReadStamp = {
  readInstance: string;
  readRevision: number;
  readSeq: number;
};

export type ReadSnapshot = ReadStamp & {
  unread: Record<string, number>;
  mentions: Message[];
  mentionsHasMore: boolean;
  mentionCounts: Record<string, number>;
};

export type MentionPage = ReadStamp & {
  messages: Message[];
  hasMore: boolean;
};
