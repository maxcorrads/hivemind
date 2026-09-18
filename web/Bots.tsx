import { useState } from "react";
import type { BotEvent, Project } from "../src/shared/types.ts";
import { api } from "./api.ts";

export function BotSetup({ project, onCreated, onBusy }: {
  project: Project;
  onCreated: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  return (
    <section className="bot-setup" aria-label="Bot setup">
      <p>Create a bot in <strong>{project.name}</strong>. It starts without channels. Invite it later from a channel’s Invite button, or ask a brain to do it.</p>
      <p>Creating a bot does not connect an integration or start an agent or monitor.</p>
      {token ? <>
        <label>Bot token — shown only now
          <input aria-label="Bot token" type="password" readOnly value={token} autoComplete="off" />
        </label>
        <button type="button" onClick={() => navigator.clipboard.writeText(token)
          .then(() => setNotice("Token copied"))
          .catch(() => setNotice("Copy failed; select the field to copy manually"))}>Copy token</button>
        <p>Created in {project.name}. No channels joined.</p>
        <small>Store the token privately in your integration, not in a message. Closing this panel hides it.</small>
      </> : <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        onBusy(true);
        setNotice("");
        try {
          const result = await api.createBot(project.id, name.trim());
          setToken(result.token);
          onCreated();
        } catch (error) {
          setNotice(String(error instanceof Error ? error.message : error));
        } finally {
          setBusy(false);
          onBusy(false);
        }
      }}>
        <label>Bot name
          <input aria-label="Bot name" required pattern={String.raw`[A-Za-z][A-Za-z0-9_\-]{0,39}`} maxLength={40}
            value={name} onChange={(e) => setName(e.target.value)} disabled={busy} placeholder="UpdatesBot" autoFocus />
        </label>
        <button type="submit" disabled={busy}>Create bot</button>
      </form>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

export function BotOrigin({ event }: { event?: BotEvent }) {
  const [copied, setCopied] = useState("");
  if (!event) return null;
  const origin = event.origin;
  return (
    <div className="bot-origin">
      <span>Bot observation{origin?.label ? ` · ${origin.label}` : ""}{origin?.author ? ` · ${origin.author}` : ""}</span>
      {origin?.occurredAt !== undefined && <time dateTime={new Date(origin.occurredAt).toISOString()}>{new Date(origin.occurredAt).toLocaleString()}</time>}
      {origin?.url && <>
        <a href={origin.url} target="_blank" rel="noreferrer">Open original</a>
        <button type="button" onClick={() => navigator.clipboard.writeText(origin.url!)
          .then(() => setCopied("Copied")).catch(() => setCopied("Copy failed"))}>{copied || "Copy link"}</button>
      </>}
    </div>
  );
}
