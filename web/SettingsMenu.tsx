import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { Settings } from "lucide-react";
import type { Snapshot } from "./api.ts";
import type { DesktopNotifications } from "./desktop-notifications.ts";
import { telegramDegraded } from "./telegram-health.ts";
import type { Layout } from "./use-layout.ts";

export type SettingsMenuProps = {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  layout: Layout;
  onLayout: (layout: Layout) => void;
  notifications: DesktopNotifications;
  telegram: Snapshot["telegram"];
  onTelegram: () => void;
  onAdaptiveRouting: () => void;
  onLaunch: () => void;
  onHelp: () => void;
};

const LAYOUTS: Array<[Layout, string]> = [["rail", "Project rail"], ["unified", "Single sidebar"]];

// Switching layout moves this menu between the sidebar and the top bar, so the new copy reopens on the
// choice the Human just made instead of dropping keyboard focus on <body>.
let reopenAfterSwitch = 0;

/** The Settings and tools menu: theme, layout, notifications, integrations, launch and help. */
export function SettingsMenu({ theme, onToggleTheme, layout, onLayout, notifications, telegram, onTelegram, onAdaptiveRouting,
  onLaunch, onHelp, iconOnly }: SettingsMenuProps & { iconOnly?: boolean }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const layoutLabel = useId();
  useEffect(() => {
    if (!menu.current || Date.now() - reopenAfterSwitch > 1000) return;
    reopenAfterSwitch = 0;
    menu.current.open = true;
    menu.current.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, []);
  // Without a remount (phones keep one layout) arrow keys still move focus onto the new choice.
  useEffect(() => {
    const group = menu.current?.querySelector('[role="radiogroup"]');
    if (group?.contains(document.activeElement)) group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [layout]);
  const pick = (next: Layout) => {
    if (next === layout) return;
    reopenAfterSwitch = Date.now();
    onLayout(next);
  };
  const onRadioKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const index = LAYOUTS.findIndex(([value]) => value === layout);
    const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    pick(LAYOUTS[(index + step + LAYOUTS.length) % LAYOUTS.length]![0]);
  };
  const degraded = telegramDegraded(telegram);
  return (
    <details className="tools-menu" ref={menu} onClick={event => {
      const button = (event.target as HTMLElement).closest("button");
      if (button && button.getAttribute("role") !== "radio") event.currentTarget.open = false;
    }}>
      <summary title="Settings and tools" className={iconOnly ? "icon-btn" : undefined} aria-label={iconOnly ? "Settings" : undefined}>
        {iconOnly ? <Settings size={16} aria-hidden="true" /> : "Settings"}
      </summary>
      <div className="tools-popover">
        <div className="tool-group">
          <span className="tool-group-label" id={layoutLabel}>Layout</span>
          <div className="seg" role="radiogroup" aria-labelledby={layoutLabel}>
            {LAYOUTS.map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={layout === value} tabIndex={layout === value ? 0 : -1}
                onClick={() => pick(value)} onKeyDown={onRadioKey}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="tool-action" title={theme === "dark" ? "Light" : "Dark"} onClick={onToggleTheme}>
          {theme === "dark" ? "Light theme" : "Dark theme"}
        </button>
        {notifications.supported && (
          <button type="button" className="tool-action" aria-pressed={notifications.enabled}
            title="Notify mentions and direct messages while Hivemind is in the background"
            onClick={() => void notifications.toggle()}>
            {notifications.blocked ? "Notifications blocked by the browser"
              : `Desktop notifications: ${notifications.enabled ? "on" : "off"}`}
          </button>
        )}
        <button
          type="button"
          className="tool-action"
          title={degraded ? `Telegram · ${telegram?.failures ?? 0} outbound failures · ${telegram?.quarantined ?? 0} quarantined · ${telegram?.retrying ?? 0} retrying${telegram?.lastError ? ` · ${telegram.lastError}` : ""}` : "Telegram"}
          onClick={onTelegram}
        >
          Telegram{degraded ? " · Needs attention" : ""}
        </button>
        <button type="button" className="tool-action" title="Adaptive routing" onClick={onAdaptiveRouting}>
          Adaptive routing
        </button>
        <button type="button" className="tool-action" title="Launch agent" onClick={onLaunch}>
          Launch agent
        </button>
        <button type="button" className="tool-action" title="How to join" onClick={onHelp}>
          Help
        </button>
      </div>
    </details>
  );
}
