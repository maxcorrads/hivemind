import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Agent } from "../src/shared/types.ts";
import type { SendLockScope, SendRoutingMode } from "./api.ts";
import { topologyLabel } from "./AdaptiveRoutingPanel.tsx";

export function Composer({
  agents,
  value,
  onChange,
  onSend,
  placeholder,
  routing,
}: {
  agents: Agent[];
  value: string;
  onChange: (v: string) => void;
  onSend: (files?: File[]) => void;
  placeholder: string;
  routing?: {
    value: SendRoutingMode;
    onChange: (mode: SendRoutingMode) => void;
    lockScope: SendLockScope;
    onLockScopeChange: (scope: SendLockScope) => void;
  };
}) {
  const [hint, setHint] = useState<Agent[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const names = useMemo(() => agents.filter((a) => a.role !== "bot"), [agents]);
  const pick = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | File[]) => {
    const next = [...files, ...Array.from(list)].slice(0, 4);
    setFiles(next);
  };

  const flush = () => {
    onSend(files);
    setFiles([]);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      flush();
    }
  };

  const onInput = (v: string) => {
    onChange(v);
    const at = v.split(/\s/).pop() ?? "";
    if (at.startsWith("@") && at.length > 1) {
      const q = at.slice(1).toLowerCase();
      setHint(names.filter((a) => a.name.toLowerCase().startsWith(q)).slice(0, 6));
    } else setHint([]);
  };

  return (
    <div
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {hint.length > 0 && (
        <ul className="hints">
          {hint.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => {
                  onChange(value.replace(/@\w*$/, `@${a.name} `));
                  setHint([]);
                }}
              >
                @{a.name}
                <small>{a.role}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul className="pending-files">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              {f.name}
              <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
        {routing && (
          <details className="composer-routing">
            <summary title="Choose how agents handle this message" aria-label="Message routing options">
              <svg className="routing-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 6h13m-3-3 3 3-3 3M17 14H4m3-3-3 3 3 3" /></svg>
              <span>{routing.value === "auto" ? "Auto · Jev" : routing.value === "orchestrated_auto" ? "Orchestrated Auto" : topologyLabel(routing.value)}</span>
              {routing.lockScope !== "none" && <span className="routing-scope">{routing.lockScope} lock</span>}
              <svg className="routing-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
            </summary>
            <div className="composer-routing-fields">
            <label>Team
            <select
              className="routing-mode"
              aria-label="Execution mode"
              title="Execution mode for this request"
              value={routing.value}
              onChange={(e) => {
                const mode = e.target.value as SendRoutingMode;
                routing.onChange(mode);
                if (mode === "auto" || mode === "orchestrated_auto") routing.onLockScopeChange("none");
              }}
            >
              <option value="auto">Auto · Jev</option>
              <option value="single">Single</option>
              <option value="brain_one_worker">Brain + 1</option>
              <option value="brain_multi_dm">Multi-DM</option>
              <option value="brain_multi_room">Room</option>
              <option value="orchestrated_auto">Orchestrated Auto</option>
            </select>
            </label>
            <label>Apply to
            <select
              className="routing-lock-mode"
              aria-label="Routing lock scope"
              title="Apply an explicit topology once, to this task, or to this conversation"
              value={routing.lockScope}
              disabled={routing.value === "auto" || routing.value === "orchestrated_auto"}
              onChange={(e) => routing.onLockScopeChange(e.target.value as SendLockScope)}
            >
              <option value="none">One request</option>
              <option value="task">Lock task</option>
              <option value="conversation">Lock conversation</option>
            </select>
            </label>
            </div>
          </details>
        )}
      <div className="composer-box">
        <input
          ref={pick}
          type="file"
          hidden
          multiple
          accept="image/*,.pdf,.txt,.csv,.json,.zip"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button type="button" className="clip" title="Attach" onClick={() => pick.current?.click()}>
          📎
        </button>
        <textarea
          rows={2}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKey}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.items]
              .filter((item) => item.kind === "file")
              .map((item) => item.getAsFile())
              .filter((f): f is File => Boolean(f));
            if (pasted.length) {
              e.preventDefault();
              addFiles(pasted);
            }
          }}
        />
        <button type="button" className="send" onClick={flush} disabled={!value.trim() && files.length === 0}>
          Send
        </button>
      </div>
    </div>
  );
}
