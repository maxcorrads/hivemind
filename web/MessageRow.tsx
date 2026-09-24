import { useCallback } from "react";
import type { Message, ThreadStatus } from "../src/shared/types.ts";
import { Msg } from "./Msg.tsx";

/**
 * Binds stream-wide handlers to one message. The handlers must be stable (one per
 * stream, taking the message), so memo(Msg) skips every row whose message did not
 * change when the stream re-renders.
 */
export function MessageRow({ m, replies, status, onThread, onReact }: {
  m: Message;
  replies: number;
  status: ThreadStatus | null;
  onThread?: (m: Message, button: HTMLButtonElement) => void;
  onReact?: (m: Message, emoji: string) => void;
}) {
  const thread = useCallback((button: HTMLButtonElement) => onThread?.(m, button), [m, onThread]);
  const react = useCallback((emoji: string) => onReact?.(m, emoji), [m, onReact]);
  return <Msg m={m} replies={replies} status={status} onThread={onThread && thread} onReact={onReact && react} />;
}
