import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent, BotCredentialView, BotEvent, Project } from "../src/shared/types.ts";
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
          setNotice(`${String(error instanceof Error ? error.message : error)}. If creation may have succeeded, find the bot in the sidebar and open Credentials to replace its lost token.`);
          onCreated(); // A lost response can still have created the identity.
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

export function BotCredentials({ bot, onBusy }: { bot: Agent; onBusy: (busy: boolean) => void }) {
  const [current, setCurrent] = useState<BotCredentialView | null>(null);
  const [token, setToken] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [confirm, setConfirm] = useState<'rotate' | 'revoke' | null>(null);
  const mounted = useRef(true), request = useRef(0), mutating = useRef(false);
  const load = useCallback(async () => {
    if (mutating.current) return;
    const id = ++request.current;
    setBusy(true); onBusy(true); setToken(''); setCurrent(null); setConfirm(null); setNotice('');
    try {
      const result = await api.botCredential(bot.projectId!, bot.id);
      if (mounted.current && id === request.current) setCurrent(result);
    } catch (e) { if (mounted.current && id === request.current) setNotice(String((e as Error).message)); }
    finally { if (mounted.current && id === request.current) { setBusy(false); onBusy(false); } }
  }, [bot.id, bot.projectId, bot.role, onBusy]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; ++request.current; }; }, [load]);
  const change = async () => {
    if (!current || !confirm || mutating.current) return;
    mutating.current = true; setBusy(true); onBusy(true); setToken(''); setNotice('');
    try {
      const result = await api.changeBotCredential(bot.projectId!, bot.id, confirm, current.credential.revision);
      if (!mounted.current) return;
      setCurrent({ bot: result.bot, credential: result.credential }); setToken(result.token ?? '');
      setNotice(result.credential.revoked ? 'Credential revoked. Existing history and channel invitations are unchanged.' : 'New token created. Update your integration configuration privately.');
    } catch (e) {
      if (mounted.current) {
        setCurrent(null);
        setNotice(`${(e as Error).message}. The outcome may be unknown. Reload credential state before another operation; a lost token cannot be retrieved, only replaced.`);
      }
    } finally { mutating.current = false; if (mounted.current) { setConfirm(null); setBusy(false); onBusy(false); } }
  };
  return <section aria-label="Bot credentials">
    <p>Manage <strong>{bot.name}</strong> in {bot.project}. Identity, channel invitations and observation history are preserved.</p>
    <p>This does not stop an external process or update its configuration. Previously authorized requests may already be in flight.</p>
    {current && <p>Credential: {current.credential.revoked ? 'revoked' : 'active'} · revision {current.credential.revision}</p>}
    <button type="button" disabled={busy} onClick={() => void load()}>Reload credential state</button>
    <button type="button" disabled={busy || !current} onClick={() => setConfirm('rotate')}>Rotate token</button>
    <button type="button" disabled={busy || !current || current.credential.revoked} onClick={() => setConfirm('revoke')}>Revoke token</button>
    {confirm && <div role="alert">
      <p>{confirm === 'rotate' ? 'Replace the current credential? The old token stops authenticating new requests immediately. Store the new token when shown.' : 'Revoke this credential? The integration will fail authentication until you rotate and configure a new token.'}</p>
      <button type="button" disabled={busy} onClick={() => void change()}>{confirm === 'rotate' ? 'Confirm rotation' : 'Confirm revocation'}</button>
      <button type="button" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
    </div>}
    {token && <>
      <label>New credential — shown only now<input aria-label="New bot token" type="password" readOnly autoComplete="off" value={token} /></label>
      <button type="button" onClick={() => navigator.clipboard.writeText(token).then(() => setNotice('Token copied')).catch(() => setNotice('Copy failed; select the field to copy manually'))}>Copy token</button>
      <button type="button" onClick={() => setToken('')}>Hide token</button>
      <p>Store it privately in the integration, never in chat. Closing or reloading this panel hides it.</p>
    </>}
    {notice && <p role="status">{notice}</p>}
  </section>;
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
