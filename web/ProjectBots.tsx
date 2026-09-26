import { useEffect, useRef, useState } from 'react';
import type { Project } from '../src/shared/types.ts';
import { BOT_CAPABILITIES, BOT_CAPABILITY_LABELS, type BotAccess, type BotCapability } from '../src/shared/bot-capabilities.ts';
import { api, type ProjectBotsView } from './api.ts';
import { BotCredentials, BotSetup } from './Bots.tsx';
import { BotSettingsEditor } from './BotSettings.tsx';
import { Modal } from './Modal.tsx';

function Capabilities({ values }: { values: BotCapability[] }) {
  return <span className="bot-capabilities">{values.length ? values.map(value => <span key={value} className="bot-capability">{BOT_CAPABILITY_LABELS[value].name}</span>) : <span>No capabilities enabled</span>}</span>;
}

export function ProjectBots({ project, initialBot, onClose, onChanged }: {
  project: Project; initialBot?: string; onClose: () => void; onChanged: () => void;
}) {
  const [view, setView] = useState<ProjectBotsView | null>(null);
  const [selected, setSelected] = useState(initialBot ?? '');
  const [working, setWorking] = useState(false), [childWorking, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const busy = working || childWorking || loading;
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    api.projectBots(project.id).then(result => { if (active) setView(result); })
      .catch(error => { if (active) { setView(null); setError(error.message); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [project.id, reload]);
  const refresh = () => { setLoading(true); setReload(value => value + 1); onChanged(); };
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setWorking(true); setError(''); setNotice('');
    try { await action(); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setWorking(false); }
  };
  const current = view?.bots.find(entry => entry.bot.id === selected);
  return <Modal onClose={() => { if (!busy) onClose(); }}>
    <div className="sheet sheet-wide bots-sheet" role="dialog" aria-modal="true" aria-label={`Bots for ${project.name}`} aria-busy={busy}>
      <header><h2>Bots <span className="bot-project">/ {project.name}</span></h2>
        <p>Connect services to this project. Combine capabilities; no agent or AI model is required.</p></header>
      <div className="sheet-body">
        {error && <p role="alert">{error}</p>}
        {view?.catalogError && <p role="alert">{view.catalogError}</p>}
        {notice && <p role="status">{notice}</p>}
        {!view && !error && <p role="status">Loading bots…</p>}
        {view && (selected === '' ? <>
          {view.bots.length === 0 && <div className="bot-empty"><h3>No bots yet</h3><p>Connect a registered service, or create a custom bot.</p></div>}
          <ul className="bot-list">{view.bots.map(({ bot, access, credential }) => <li key={bot.id}>
            <button className="bot-list-item" type="button" onClick={() => setSelected(bot.id)} disabled={busy}>
              <span><strong>{bot.name}</strong><small>{credential.revoked ? 'Credential revoked' : access.definitionId ? view.definitions.find(a => a.id === access.definitionId)?.name ?? 'Definition unavailable' : 'Custom bot'} · process status not checked</small></span>
              <Capabilities values={access.capabilities} /><span aria-hidden="true">›</span>
            </button>
          </li>)}</ul>
          <button className="primary" type="button" disabled={busy} onClick={() => setSelected('new')}>Add bot</button>
        </> : selected === 'new' ? <>
          <button type="button" className="text-btn" disabled={busy} onClick={() => setSelected('')}>← All bots</button>
          <AddBot project={project} view={view} busy={busy} onBusy={setBusy} run={run} onSaved={definition => setView(v => v && ({ ...v, definitions: v.definitions.map(a => a.id === definition.id ? definition : a) }))}
            onCreated={(id, message) => { refresh(); if (id) setSelected(id); if (message) setNotice(message); }} />
        </> : current ? <>
          <button type="button" className="text-btn" disabled={busy} onClick={() => setSelected('')}>← All bots</button>
          <BotDetail key={`${current.bot.id}:${current.access.revision}`} project={project} entry={current} view={view} busy={busy} onBusy={setBusy} run={run}
            onChanged={refresh} onNotice={setNotice} onSavedDefinition={definition => setView(v => v && ({ ...v, definitions: v.definitions.map(a => a.id === definition.id ? definition : a) }))} />
        </> : <p role="status">Refreshing bot… <button type="button" disabled={busy} onClick={() => setSelected('')}>All bots</button></p>)}
      </div>
      <div className="row"><button type="button" disabled={busy} onClick={() => { setError(''); refresh(); }}>Refresh</button><button type="button" disabled={busy} onClick={onClose}>Close</button></div>
    </div>
  </Modal>;
}

type Definition = ProjectBotsView['definitions'][number];
type Run = (action: () => Promise<void>) => Promise<void>;
function AddBot({ project, view, busy, onBusy, run, onSaved, onCreated }: {
  project: Project; view: ProjectBotsView; busy: boolean; onBusy: (busy: boolean) => void; run: Run;
  onSaved: (definition: Definition) => void; onCreated: (id?: string, message?: string) => void;
}) {
  const [definitionId, setDefinitionId] = useState(''), [name, setName] = useState('');
  const definition = view.definitions.find(a => a.id === definitionId);
  return <section aria-label="Add bot"><h3>Add bot</h3>
    <p className="help-p">Bots are installed as external packages. Register a trusted bot on this computer with <code>hivemind bots add /absolute/package/hivemind-bot.json</code>, then refresh. Installing or registering a bot does not start it.</p>
    <label>Service<select value={definitionId} disabled={busy || !!view.catalogError} onChange={e => { setDefinitionId(e.target.value); setName(view.definitions.find(a => a.id === e.target.value)?.name.replace(/[^A-Za-z0-9_-]/g, '') ?? ''); }}>
      <option value="">Custom bot</option>{definitionId && !definition && <option value={definitionId}>{definitionId} · unavailable</option>}
      {view.definitions.filter(a => !view.bots.some(b => b.access.definitionId === a.id)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
    </select></label>
    {!definitionId ? <BotSetup project={project} onBusy={onBusy} onCreated={() => onCreated()} /> : !definition ? <p>Selected service unavailable. Repair the catalog and refresh before creating this bot.</p> : <>
      <Capabilities values={(definition.capabilities ?? []).filter(cap => cap !== 'receive')} />
      <BotSettingsEditor key={`${definition.id}:${definition.revision}`} configuration={definition} project={project} busy={busy} onBusy={onBusy} onSaved={onSaved} />
      <form onSubmit={e => { e.preventDefault(); void run(async () => { const result = await api.setupBot(project.id, name.trim(), definition.id); onCreated(result.bot.id, result.error ?? 'Bot connected. Invite it to a channel before following a source. Monitoring has not started.'); }); }}>
        <label>Bot name<input value={name} disabled={busy} required pattern={String.raw`[A-Za-z][A-Za-z0-9_\-]{0,39}`} maxLength={40} onChange={e => setName(e.target.value)} /></label>
        <p className="help-p">Creating this bot enables the capabilities shown above. It does not start its monitor. Credentials are stored privately in its local profile.</p>
        <button className="primary" type="submit" disabled={busy || !definition.configured || !definition.enabled || !!definition.error}>{busy ? 'Connecting…' : 'Create and connect bot'}</button>
        {!definition.configured && <p className="help-p">Configure this service first.</p>}
      </form>
    </>}
  </section>;
}

function BotDetail({ project, entry, view, busy, onBusy, run, onChanged, onNotice, onSavedDefinition }: {
  project: Project; entry: ProjectBotsView['bots'][number]; view: ProjectBotsView; busy: boolean;
  onBusy: (busy: boolean) => void; run: Run; onChanged: () => void; onNotice: (notice: string) => void; onSavedDefinition: (definition: Definition) => void;
}) {
  const [draft, setDraft] = useState<BotAccess>(entry.access), [status, setStatus] = useState<unknown>(null);
  const [confirmConnect, setConfirmConnect] = useState(false), [advanced, setAdvanced] = useState(false);
  const [credentialEpoch, setCredentialEpoch] = useState(0);
  const definition = view.definitions.find(a => a.id === draft.definitionId);
  const savedDefinition = view.definitions.find(a => a.id === entry.access.definitionId);
  const unavailableDefinition = draft.definitionId !== null && (!definition || !!definition.error || !!view.catalogError);
  const supportedCapabilities = draft.definitionId === null ? ['publish', 'receive'] : unavailableDefinition
    ? draft.definitionId === entry.access.definitionId ? entry.access.capabilities : []
    : definition?.capabilities ?? [];
  const channels = view.channels.filter(ch => ['public', 'private'].includes(ch.type) && ch.memberIds.includes(entry.bot.id));
  const toggle = (cap: BotCapability, checked: boolean) => setDraft(d => ({ ...d, capabilities: checked ? [...d.capabilities, cap] : d.capabilities.filter(c => c !== cap), receiveChannels: cap === 'receive' && !checked ? [] : d.receiveChannels }));
  return <section aria-label={`Manage ${entry.bot.name}`}>
    <h3>{entry.bot.name}</h3><Capabilities values={entry.access.capabilities} />
    <p className="help-p">Capabilities control access. They do not start processes or authorize tasks.</p>
    <form onSubmit={e => { e.preventDefault(); void run(async () => { await api.setBotAccess(project.id, entry.bot.id, { capabilities: draft.capabilities, receiveChannels: draft.receiveChannels, definitionId: draft.definitionId, expectedRevision: entry.access.revision }); onNotice('Bot access saved. In-flight requests may finish; monitor state is unchanged.'); onChanged(); }); }}>
      <label>Service<select value={draft.definitionId ?? ''} disabled={busy || !!view.catalogError} onChange={e => {
        const id = e.target.value || null, supported = id ? view.definitions.find(a => a.id === id)?.capabilities ?? [] : ['publish', 'receive'];
        setDraft(d => ({ ...d, definitionId: id, capabilities: d.capabilities.filter(cap => supported.includes(cap)), receiveChannels: supported.includes('receive') ? d.receiveChannels : [] }));
      }}><option value="">Custom bot</option>{draft.definitionId && !definition && <option value={draft.definitionId}>{draft.definitionId} · unavailable</option>}
        {view.definitions.filter(a => a.id === entry.access.definitionId || !view.bots.some(b => b.access.definitionId === a.id)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      {unavailableDefinition && <p className="help-p">Service unavailable. The saved connection is retained; you can remove access and manage credentials without the catalog.</p>}
      <fieldset disabled={busy}><legend>Capabilities</legend>{BOT_CAPABILITIES.map(cap => <label className="bot-access-choice" key={cap}>
        <input type="checkbox" checked={draft.capabilities.includes(cap)} disabled={!draft.capabilities.includes(cap) && !supportedCapabilities.includes(cap)} onChange={e => toggle(cap, e.target.checked)} />
        <span><strong>{BOT_CAPABILITY_LABELS[cap].name}</strong><small>{BOT_CAPABILITY_LABELS[cap].description}</small></span>
      </label>)}</fieldset>
      {draft.capabilities.includes('receive') && <fieldset disabled={busy}><legend>Receive from these channels</legend>
        {channels.length === 0 && <p>Invite this bot to a channel first. No messages can be read yet.</p>}
        {channels.map(ch => <label className="check" key={ch.id}><input type="checkbox" checked={draft.receiveChannels.includes(ch.id)} disabled={unavailableDefinition && !entry.access.receiveChannels.includes(ch.id)} onChange={e => setDraft(d => ({ ...d, receiveChannels: e.target.checked ? [...d.receiveChannels, ch.id] : d.receiveChannels.filter(id => id !== ch.id) }))} />#{ch.name}</label>)}
      </fieldset>}
      <button type="submit" className="primary" disabled={busy}>Save access</button>
    </form>
    {savedDefinition && <>
      <details className="bot-section"><summary>Service settings</summary><BotSettingsEditor key={`${savedDefinition.id}:${savedDefinition.revision}`} configuration={savedDefinition} project={project} busy={busy} onBusy={onBusy} onSaved={onSavedDefinition} /></details>
      <section className="bot-section" aria-label="Monitor"><h4>Monitor</h4><p className="help-p">Status is checked on demand. Saving settings never starts the monitor.</p>
        <div className="row">{(['status', 'start', 'stop'] as const).filter(action => savedDefinition.tools?.some(t => t.name === action)).map(action => <button key={action} type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await api.controlBot(project.id, entry.bot.id, action, entry.access.revision); setStatus(result.result);
          onNotice(action === 'stop' ? 'Stop requested. Check status to confirm the monitor has exited.' : action === 'start' ? 'Start requested. Check status for current activity.' : 'Status checked.');
        })}>{action === 'status' ? 'Check status' : action === 'start' ? 'Start monitor' : 'Stop monitor'}</button>)}</div>
        {status !== null && <details open><summary>Last result</summary><pre className="bot-result">{JSON.stringify(status, null, 2)}</pre></details>}
      </section>
      <details className="bot-section"><summary>Tools available to brains ({savedDefinition.tools?.length ?? 0})</summary>
        <p className="help-p">Requires Tools to be enabled, an enabled service and active credentials. A brain still needs task authorization.</p>
        <dl className="bot-tools">{savedDefinition.tools?.map(tool => <div key={tool.name}><dt><code>{tool.name}</code> · {tool.effect === 'read' ? 'Read only' : 'Changes monitoring'}</dt><dd>{tool.description}</dd></div>)}</dl>
      </details>
    </>}
    <details className="bot-section" onToggle={event => {
      if (busy) { event.currentTarget.open = advanced; return; }
      setAdvanced(event.currentTarget.open);
    }}><summary>Advanced · credentials and connection</summary>
      {advanced && <BotCredentials key={credentialEpoch} bot={entry.bot} onBusy={onBusy} disabled={busy} onChanged={onChanged} />}
      {savedDefinition && <><p>Reconnect replaces this bot’s token and updates the service profile. Stop the monitor first. Other clients using the old token will stop authenticating.</p>
        {!confirmConnect ? <button type="button" disabled={busy} onClick={() => setConfirmConnect(true)}>Reconnect service…</button> : <div role="alert"><p>Replace the token and connect {entry.bot.name} to {savedDefinition.name}?</p>
          <button type="button" disabled={busy} onClick={() => void run(async () => {
            try {
              const latest = await api.botCredential(project.id, entry.bot.id);
              await api.connectBot(project.id, entry.bot.id, latest.credential.revision, entry.access.revision);
              onNotice('Service reconnected. Monitor has not started.');
            } finally {
              // Even a failed/lost receipt may have replaced the credential.
              setConfirmConnect(false); setCredentialEpoch(value => value + 1); onChanged();
            }
          })}>Replace token and connect</button>
          <button type="button" disabled={busy} onClick={() => setConfirmConnect(false)}>Cancel</button>
        </div>}</>}
    </details>
  </section>;
}
