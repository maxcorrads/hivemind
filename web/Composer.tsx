import { AtSign, Paperclip, SendHorizontal, Smile, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Agent } from "../src/shared/types.ts";
import { ALL_EMOJIS, EmojiPicker } from "./EmojiPicker.tsx";

/** The `@name` fragment being typed just before the caret, if any. */
const MENTION_TAIL = /@[^\s@]*$/;

/**
 * Message input. The draft lives here, not in App, so typing re-renders only the
 * composer. `onSend` resolves true once the message is committed; on false the
 * draft and attachments stay put so the same send can be retried.
 * `compact` (for the narrow thread pane) drops the emoji button and key hint and shows Send as an icon.
 */
export function Composer({
  agents,
  onSend,
  placeholder,
  compact = false,
}: {
  agents: Agent[];
  onSend: (body: string, files: File[]) => Promise<boolean>;
  placeholder: string;
  compact?: boolean;
}) {
  const [value, setValue] = useState("");
  const [hint, setHint] = useState<Agent[]>([]);
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const sendingRef = useRef(false);
  const names = useMemo(() => agents.filter((a) => a.role !== "bot"), [agents]);
  const pick = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const emojiBox = useRef<HTMLDivElement>(null);
  const emojiToggle = useRef<HTMLButtonElement>(null);
  // Where the caret goes once a programmatic edit (a picked mention, @, an emoji) has rendered.
  const caretAfter = useRef<number | null>(null);
  const listId = useId();

  useLayoutEffect(() => {
    const at = caretAfter.current;
    if (at === null || !input.current) return;
    caretAfter.current = null;
    input.current.focus();
    input.current.setSelectionRange(at, at);
  }, [value]);

  // The emoji picker takes focus when it opens and closes on a click outside it (Escape: see its onKeyDown).
  useEffect(() => {
    if (!emoji) return;
    emojiBox.current?.querySelector("button")?.focus();
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!emojiBox.current?.contains(target) && !emojiToggle.current?.contains(target)) setEmoji(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [emoji]);

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

  const caret = () => input.current?.selectionStart ?? value.length;

  const onInput = (v: string, at = v.length) => {
    setValue(v);
    const word = v.slice(0, at).split(/\s/).pop() ?? "";
    // A bare "@" already offers everyone; each typed letter narrows the list.
    if (word.startsWith("@")) {
      const q = word.slice(1).toLowerCase();
      setHint(names.filter((a) => a.name.toLowerCase().startsWith(q)).slice(0, 6));
    } else setHint([]);
    setActive(0);
  };

  /** Replaces the `@fragment` before the caret with the picked name. */
  const insert = (agent: Agent) => {
    const at = caret();
    const rest = value.slice(at);
    const before = value.slice(0, at).replace(MENTION_TAIL, /^\s/.test(rest) ? `@${agent.name}` : `@${agent.name} `);
    const next = before + rest;
    if (next === value) {
      // Nothing changes (the name was already typed out), so no render moves the caret: place it now.
      input.current?.focus();
      input.current?.setSelectionRange(before.length, before.length);
    } else {
      caretAfter.current = before.length;
      setValue(next);
    }
    setHint([]);
  };

  /** Types `text` over the selection, as if the Human had typed it there. */
  const typeAtCaret = (text: string) => {
    const start = input.current?.selectionStart ?? value.length, end = input.current?.selectionEnd ?? value.length;
    caretAfter.current = start + text.length;
    onInput(value.slice(0, start) + text + value.slice(end), start + text.length);
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

  const open = hint.length > 0;
  return (
    <div
      className={compact ? "composer compact" : "composer"}
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
      {emoji && (
        <div className="composer-emoji" ref={emojiBox} onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          setEmoji(false);
          emojiToggle.current?.focus();
        }}>
          <EmojiPicker emojis={ALL_EMOJIS} label="Emoji" className="emoji-picker" buttonLabel={(e) => `Insert ${e}`}
            onPick={(e) => { setEmoji(false); typeAtCaret(e); }} />
        </div>
      )}
      {files.length > 0 && (
        <ul className="pending-files">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <Paperclip size={13} aria-hidden="true" />
              {f.name}
              <button type="button" disabled={sending} aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                <X size={13} aria-hidden="true" />
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
        <textarea
          ref={input}
          rows={compact ? 1 : 2}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${Math.min(active, hint.length - 1)}` : undefined}
          onChange={(e) => onInput(e.target.value, e.target.selectionStart ?? e.target.value.length)}
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
        <div className="composer-bar">
          <button type="button" className="icon-btn clip" title="Attach" aria-label="Attach files" onClick={() => pick.current?.click()}>
            <Paperclip size={16} aria-hidden="true" />
          </button>
          {/* Opens the mention list; a mention must start a word ("a@b" is not one), so it may bring a space. */}
          <button type="button" className="icon-btn" title="Mention someone" aria-label="Mention someone"
            onClick={() => typeAtCaret(/\S$/.test(value.slice(0, caret())) ? " @" : "@")}>
            <AtSign size={16} aria-hidden="true" />
          </button>
          {!compact && (
            <button type="button" className="icon-btn" title="Emoji" aria-label="Insert emoji" aria-expanded={emoji}
              ref={emojiToggle} onClick={() => { setHint([]); setEmoji((on) => !on); }}>
              <Smile size={16} aria-hidden="true" />
            </button>
          )}
          {!compact && <span className="composer-hint"><kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> new line</span>}
          <button type="button" className={compact ? "btn btn-primary send icon-only" : "btn btn-primary send"} onClick={() => void flush()}
            disabled={sending || (!value.trim() && files.length === 0)} aria-busy={sending}>
            <SendHorizontal size={14} aria-hidden="true" />
            {compact ? <span className="sr-only">Send</span> : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
