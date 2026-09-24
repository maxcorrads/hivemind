import type { KeyboardEvent, RefObject } from "react";

/**
 * Keyboard handling shared by the sidebar action menus: arrows/Home/End move between items,
 * Escape closes and returns focus to the trigger, Tab closes and lets focus leave from the trigger.
 */
export function menuKeyDown(event: KeyboardEvent<HTMLElement>, trigger: RefObject<HTMLElement | null>, close: () => void) {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    trigger.current?.focus();
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  } else if (event.key === "Tab") {
    trigger.current?.focus();
    close();
  }
}

/** Focuses the first item of a menu that just opened. */
export function focusFirstMenuItem(menu: HTMLElement | null) {
  menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
}
