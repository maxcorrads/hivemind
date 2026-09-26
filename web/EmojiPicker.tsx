import type { KeyboardEvent } from "react";
import { EXTRA_REACTION_EMOJIS, REACTION_EMOJIS } from "../src/shared/types.ts";

/** Every emoji the hive accepts as a reaction; the composer offers the same set. */
export const ALL_EMOJIS: readonly string[] = [...REACTION_EMOJIS, ...EXTRA_REACTION_EMOJIS];

/**
 * A group of emoji buttons: the reaction picks on a message and the composer's emoji picker. Arrow keys move
 * between buttons (wrapping), so a keyboard user does not have to Tab through all of them.
 */
export function EmojiPicker({ emojis, label, className, buttonLabel, pressed, onPick }: {
  emojis: readonly string[];
  label: string;
  className: string;
  buttonLabel: (emoji: string) => string;
  /** Set for reactions: the Human's own reaction reads as pressed. */
  pressed?: (emoji: string) => boolean;
  onPick: (emoji: string) => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    buttons[(at + step + buttons.length) % buttons.length]!.focus();
  };
  return (
    <div className={className} role="group" aria-label={label} onKeyDown={onKeyDown}>
      {emojis.map((emoji) => {
        const on = pressed?.(emoji);
        return (
          <button key={emoji} type="button" className={`react-pick-btn ${on ? "mine" : ""}`} title={emoji}
            aria-pressed={pressed ? Boolean(on) : undefined} aria-label={buttonLabel(emoji)} onClick={() => onPick(emoji)}>
            {emoji}
          </button>
        );
      })}
    </div>
  );
}
