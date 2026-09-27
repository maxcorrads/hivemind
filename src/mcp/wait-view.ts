import type { WaitResult } from "../shared/types.ts";
import { WAIT_NEXT_REPEAT } from "./tool-text.ts";

/**
 * What the model sees of a wait result, per MCP session. The HTTP result is unchanged; this only drops what the
 * model already has: `you` after it was shown (again whenever it changes), the full `next` after the first mail
 * (a short reminder of the loop stays on every wake), and the legacy arrays compact waits always leave empty.
 */
export function createWaitView() {
  let shownYou: string | null = null;
  let shownNext = false;
  return (result: WaitResult): Record<string, unknown> => {
    const { next, you, control, mentions, messages, ...rest } = result;
    const youKey = JSON.stringify(you);
    const view: Record<string, unknown> = { next: shownNext ? WAIT_NEXT_REPEAT : next };
    shownNext = true;
    if (youKey !== shownYou) {
      view.you = you;
      shownYou = youKey;
    }
    if (control.length) view.control = control;
    if (mentions.length) view.mentions = mentions;
    if (messages.length) view.messages = messages;
    return Object.assign(view, rest);
  };
}
