import { useCallback } from "react";
import type { Message, ThreadStatus } from "../src/shared/types.ts";
import { Msg } from "./Msg.tsx";

/**
 * Binds stream-wide handlers to one message. The handlers must be stable (one per
 * stream, taking the message), so memo(Msg) skips every row whose message did not
 * change when the stream re-renders. `grouped`, `threadOpen` and `taskRoute` are primitives.
 */
export function MessageRow({ m, replies, status, grouped, threadOpen, taskRoute, onThread, onReact, onMarkUnread }: {
  m: Message;
  replies: number;
  status: ThreadStatus | null;
  grouped?: boolean;
  threadOpen?: boolean;
  taskRoute?: string;
  onThread?: (m: Message, anchor: HTMLElement) => void;
  onReact?: (m: Message, emoji: string) => void;
  onMarkUnread?: (m: Message) => void;
}) {
  const thread = useCallback((anchor: HTMLElement) => onThread?.(m, anchor), [m, onThread]);
  const react = useCallback((emoji: string) => onReact?.(m, emoji), [m, onReact]);
  return <Msg m={m} replies={replies} status={status} grouped={grouped} threadOpen={threadOpen} taskRoute={taskRoute}
    onThread={onThread && thread} onReact={onReact && react} onMarkUnread={onMarkUnread} />;
}
