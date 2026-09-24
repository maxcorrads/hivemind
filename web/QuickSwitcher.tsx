import { useEffect, useMemo, useState } from "react";
import type { Snapshot } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { switcherItems, type SwitchItem } from "./nav-model.ts";

const KIND_LABEL = { channel: "Channel", dm: "Direct message", agent: "Agent", project: "Project" } as const;

/** Cmd/Ctrl+K: jump to any channel, DM, agent or project by typing part of its name. */
export function QuickSwitcher({ snap, currentProject, onPick, onClose }: {
  snap: Snapshot;
  currentProject: string;
  onPick: (item: SwitchItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const items = useMemo(() => switcherItems(snap, query, currentProject), [snap, query, currentProject]);
  const current = items[Math.min(active, items.length - 1)];
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (current) document.getElementById(`switch-${current.key}`)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  return (
    <Modal onClose={onClose}>
      <div className="sheet switcher" role="dialog" aria-modal="true" aria-label="Jump to">
        <input className="switcher-input" autoFocus value={query} onChange={event => setQuery(event.target.value)}
          role="combobox" aria-expanded="true" aria-controls="switcher-options" aria-autocomplete="list"
          aria-activedescendant={current ? `switch-${current.key}` : undefined}
          aria-label="Jump to a channel, conversation, agent or project" placeholder="Jump to…"
          onKeyDown={event => {
            const last = items.length - 1;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive(index => (Math.min(index, last) + (event.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(items.length, 1));
            } else if (event.key === "Home" && event.ctrlKey) { event.preventDefault(); setActive(0); }
            else if (event.key === "End" && event.ctrlKey) { event.preventDefault(); setActive(last); }
            else if (event.key === "Enter" && current) { event.preventDefault(); onPick(current); }
          }} />
        <ul className="switcher-options" id="switcher-options" role="listbox" aria-label="Matches">
          {items.map((item, index) => (
            <li key={item.key} id={`switch-${item.key}`} role="option" aria-selected={item === current}
              className={item === current ? "active" : ""}
              onPointerMove={() => { if (index !== active) setActive(index); }}
              onClick={() => onPick(item)}>
              <span className="switcher-label">{item.label}</span>
              <span className="switcher-hint">{KIND_LABEL[item.kind]}{item.hint ? ` · ${item.hint}` : ""}</span>
              {(item.kind === "channel" || item.kind === "dm") && item.unread > 0 && <em>{item.unread}</em>}
            </li>
          ))}
        </ul>
        {items.length === 0 && <p className="empty-mini">No channel, conversation, agent or project matches.</p>}
        <p className="switcher-keys">↑ ↓ to move · Enter to open · Esc to close</p>
      </div>
    </Modal>
  );
}
