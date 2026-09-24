import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Agent } from "../src/shared/types.ts";

/** The `@name` fragment being typed at the end of the draft, if any. */
const MENTION_TAIL = /@[^\s@]*$/;

/**
 * Message input. The draft lives here, not in App, so typing re-renders only the
 * composer. `onSend` resolves true once the message is committed; on false the
 * draft and attachments stay put so the same send can be retried.
 */
export function Composer({
  agents,
  onSend,
  placeholder,
}: {
  agents: Agent[];
  onSend: (body: string, files: File[]) => Promise<boolean>;
  placeholder: string;
}) {
  const [value, setValue] = useState("");
  const [hint, setHint] = useState<Agent[]>([]);
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const names = useMemo(() => agents.filter((a) => a.role !== "bot"), [agents]);
  const pick = useRef<HTMLInputElement>(null);
  const listId = useId();

  const addFiles = (list: FileList | File[]) => {
    const next = [...files, ...Array.from(list)].slice(0, 4);
    setFiles(next);
  };

  const flush = async () => {
    if (sendingRef.current || (!value.trim() && files.length === 0)) return;
    const body = value, sent = files;
    sendingRef.current = true;
    setSending(true);
    try {
      if (!await onSend(body, sent)) return;
      // Keep anything typed or attached while the send was in flight.
      setValue((current) => current === body ? "" : current);
      setFiles((current) => current.filter((file) => !sent.includes(file)));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const insert = (agent: Agent) => {
    setValue((current) => current.replace(MENTION_TAIL, `@${agent.name} `));
    setHint([]);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter confirms an IME composition (e.g. Japanese, Chinese); it must not send or pick.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (hint.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + step + hint.length) % hint.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        e.preventDefault();
        insert(hint[Math.min(active, hint.length - 1)]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setHint([]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void flush();
    }
  };

  const onInput = (v: string) => {
    setValue(v);
    const at = v.split(/\s/).pop() ?? "";
    if (at.startsWith("@") && at.length > 1) {
      const q = at.slice(1).toLowerCase();
      setHint(names.filter((a) => a.name.toLowerCase().startsWith(q)).slice(0, 6));
    } else setHint([]);
    setActive(0);
  };

  const open = hint.length > 0;
  return (
    <div
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {open && (
        <ul className="hints" id={listId} role="listbox" aria-label="Mention">
          {hint.map((a, i) => (
            <li key={a.id} role="option" id={`${listId}-${i}`} aria-selected={i === active}>
              <button
                type="button"
                tabIndex={-1}
                className={i === active ? "active" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(a)}
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
              <button type="button" disabled={sending} aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
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
        <button type="button" className="clip" title="Attach" aria-label="Attach files" onClick={() => pick.current?.click()}>
          <span aria-hidden="true">📎</span>
        </button>
        <textarea
          rows={2}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${Math.min(active, hint.length - 1)}` : undefined}
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
        <button type="button" className="send" onClick={() => void flush()}
          disabled={sending || (!value.trim() && files.length === 0)} aria-busy={sending}>
          Send
        </button>
      </div>
    </div>
  );
}
