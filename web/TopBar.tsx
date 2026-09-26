import { CircleHelp, Search } from "lucide-react";
import { SWITCHER_SHORTCUT } from "./nav-model.ts";
import { SettingsMenu, type SettingsMenuProps } from "./SettingsMenu.tsx";

/**
 * The single-sidebar layout's top bar: brand, the quick switcher (Cmd/Ctrl+K), connection state, help,
 * the Settings menu and who you are. It replaces the project rail and the sidebar's brand row.
 */
export function TopBar({ live, projectName, onSwitcher, settings }: {
  live: boolean;
  projectName: string | undefined;
  onSwitcher: () => void;
  settings: SettingsMenuProps;
}) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <img src="/icon.svg" alt="" />
        <span>hivemind</span>
      </div>
      <button type="button" className="topbar-search" onClick={onSwitcher} aria-keyshortcuts="Meta+K Control+K">
        <Search size={14} aria-hidden="true" />
        <span>{projectName ? `Jump to… in ${projectName} or anywhere` : "Jump to…"}</span>
        <kbd className="kbd">{SWITCHER_SHORTCUT}</kbd>
      </button>
      <div className="topbar-tools">
        <span className="topbar-live">
          <span className={`pulse ${live ? "on" : ""}`} title={live ? "live" : "waiting"} role="img"
            aria-label={live ? "Connected" : "Not connected"} />
          <span aria-hidden="true">{live ? "Live" : "Offline"}</span>
        </span>
        <button type="button" className="icon-btn" title="How to join" aria-label="Help" onClick={settings.onHelp}>
          <CircleHelp size={16} aria-hidden="true" />
        </button>
        <SettingsMenu {...settings} iconOnly />
        <span className="avatar topbar-me" role="img" aria-label="You are Human" title="You are Human">Hu</span>
      </div>
    </header>
  );
}
