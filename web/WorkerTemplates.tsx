import { Copy, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Project, Seniority } from "../src/shared/types.ts";
import { buildLaunchCommand } from "../src/shared/launch-prompt.ts";
import { launchEnvironmentPrefix, parseLaunchEnvironment } from "../src/shared/launch-environment.ts";
import type { WorkerTemplate, WorkerTemplateSpec } from "../src/shared/worker-templates.ts";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import { templateSecretValueProblem } from "./native-bridge.ts";
import { TerminalRequestError, terminalHub, useTerminalState } from "./use-terminal.ts";

export function emptyTemplateSpec(): WorkerTemplateSpec {
  return { label: "", description: "", software: "codex", model: "", effort: "", extraFlags: "", environment: {},
    secretNames: [], seniority: "senior", focus: "", maxConcurrent: 2, enabled: true };
}

/**
 * The Environment variables field's text for saved variables, one NAME=value per line. The field strips one pair of
 * matching outer quotes, so a value that has them is wrapped in the other kind to come back unchanged.
 */
export function environmentText(environment: Record<string, string>): string {
  return Object.entries(environment).map(([name, value]) => {
    const quoted = value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'");
    return `${name}=${quoted ? (value[0] === '"' ? `'${value}'` : `"${value}"`) : value}`;
  }).join("\n");
}

/** Secret names from the field's text: one per line, blank lines ignored. */
export function secretNamesFrom(text: string): string[] {
  return text.split("\n").map(line => line.trim()).filter(Boolean);
}

/** What the template will run (without the prompt Hivemind adds at launch), or why it cannot. */
export function templateCommandPreview(spec: WorkerTemplateSpec, project: Pick<Project, "slug" | "worktree">):
  { ok: true; text: string } | { ok: false; error: string } {
  try {
    const { command } = buildLaunchCommand({ software: spec.software, model: spec.model, effort: spec.effort,
      extraFlags: spec.extraFlags, workspacePath: project.worktree, cdWorktree: Boolean(project.worktree),
      projectSlug: project.slug, passProject: true, role: "worker", seniority: spec.seniority, focus: spec.focus || null,
      adoptUntrusted: true });
    const prefix = launchEnvironmentPrefix(spec.environment);
    return { ok: true, text: prefix ? `${prefix} ${command}` : command };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

const describe = (spec: WorkerTemplateSpec) =>
  [spec.software, spec.model && (spec.effort ? `${spec.model} · ${spec.effort}` : spec.model), spec.seniority,
    `up to ${spec.maxConcurrent} at once`].filter(Boolean).join(" · ");

type Editing = { template: WorkerTemplate | null; slug: string; spec: WorkerTemplateSpec };

/** Project settings → Worker templates: the workers this project's brains may launch. */
export function WorkerTemplatesSheet({ project, onClose }: { project: Project; onClose: () => void }) {
  const [templates, setTemplates] = useState<WorkerTemplate[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<WorkerTemplate | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    api.workerTemplates(project.slug)
      .then(result => { if (active) setTemplates(result.templates); })
      .catch(failure => { if (active) setError(String(failure.message || failure)); });
    return () => { active = false; };
  }, [project.slug, reload]);

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteWorkerTemplate(deleting.id, deleting.revision);
      setDeleting(null);
      setReload(value => value + 1);
      const hub = terminalHub();
      if (hub && deleting.spec.secretNames.length > 0) {
        await hub.deleteTemplateSecrets(deleting.id, null).catch(failure =>
          setError(`The template is deleted, but its secret values are still in the Keychain: ${secretsErrorText(failure)}`));
      }
    } catch (failure) {
      setError(String((failure as Error).message || failure));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={() => { if (!busy && !editing && !deleting) onClose(); }}>
      <div className="sheet sheet-wide worker-templates" role="dialog" aria-modal="true" aria-label={`Worker templates for ${project.name}`}
        onClick={event => event.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2>{project.name} · Worker templates</h2>
            <p>The workers this project's brains may launch, one per task. Nothing launches from here.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close dialog" title="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="sheet-body">
          {error && <p className="err" role="alert">{error}</p>}
          {editing ? (
            <TemplateEditor project={project} editing={editing} busy={busy} onBusy={setBusy}
              onCancel={() => setEditing(null)}
              onSaved={() => { setEditing(null); setReload(value => value + 1); }} />
          ) : <>
            {templates === null && !error && <p role="status">Loading…</p>}
            {templates?.length === 0 && (
              <p className="help-p">No templates yet. Add one for each kind of worker brains should be able to launch.</p>
            )}
            {templates?.map(template => (
              <section key={template.id} className="plugin-card" aria-label={template.spec.label}>
                <div className="plugin-heading">
                  <strong>{template.spec.label}</strong>
                  <code>{template.slug}</code>
                  <span>{template.spec.enabled ? describe(template.spec) : `Disabled · ${describe(template.spec)}`}</span>
                  <button type="button" className="btn" disabled={busy} aria-label={`Edit ${template.spec.label}`}
                    onClick={() => setEditing({ template, slug: template.slug, spec: structuredClone(template.spec) })}>
                    <Pencil size={13} aria-hidden="true" /> Edit
                  </button>
                  <button type="button" className="btn" disabled={busy} aria-label={`Duplicate ${template.spec.label}`}
                    onClick={() => setEditing({ template: null, slug: `${template.slug}-copy`.slice(0, 32),
                      spec: { ...structuredClone(template.spec), label: `${template.spec.label} (copy)`.slice(0, 80) } })}>
                    <Copy size={13} aria-hidden="true" /> Duplicate
                  </button>
                  <button type="button" className="btn btn-danger" disabled={busy} aria-label={`Delete ${template.spec.label}`}
                    onClick={() => setDeleting(template)}>
                    <Trash2 size={13} aria-hidden="true" /> Delete
                  </button>
                </div>
                <p className="help-p">{template.spec.description}</p>
                {template.spec.secretNames.length > 0 && (
                  <p className="help-p">Secrets: {template.spec.secretNames.join(", ")}</p>
                )}
              </section>
            ))}
          </>}
        </div>
        {!editing && (
          <div className="row">
            <button type="button" className="primary" disabled={busy || templates === null}
              onClick={() => setEditing({ template: null, slug: "", spec: emptyTemplateSpec() })}>
              <Plus size={14} aria-hidden="true" /> New template
            </button>
            <button type="button" disabled={busy} onClick={onClose}>Close</button>
          </div>
        )}
      </div>
      {deleting && (
        <Modal onClose={() => { if (!busy) setDeleting(null); }}>
          <div className="sheet" role="alertdialog" aria-modal="true" aria-label={`Delete ${deleting.spec.label}`}
            onClick={event => event.stopPropagation()}>
            <h2>Delete {deleting.spec.label}?</h2>
            <p className="help-p">Brains can no longer launch this worker. Workers already running are not affected.</p>
            <div className="row">
              <button type="button" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
              <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
                {busy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

/** What the page says when the app cannot keep template secrets, from the hub's error. */
export function secretsErrorText(error: unknown): string {
  if (error instanceof TerminalRequestError && error.code === "unknown-type") return "Update Hivemind Server to keep template secrets.";
  return String((error as Error)?.message || error);
}

/**
 * The saved template's secret values, kept by Hivemind Server.app in the macOS Keychain: whether each declared name has
 * one, and a write-only field to set or replace it. Values never come back to the page.
 */
function SecretValues({ template }: { template: WorkerTemplate }) {
  const terminals = useTerminalState();
  const hub = terminalHub();
  const declared = template.spec.secretNames;
  const [stored, setStored] = useState<string[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connected = terminals.native && terminals.broker === "connected";
  useEffect(() => {
    if (!hub || !connected) return;
    let active = true;
    hub.templateSecrets(template.id)
      .then(names => { if (active) setStored(names); })
      .catch(failure => { if (active) setError(secretsErrorText(failure)); });
    return () => { active = false; };
  }, [hub, connected, template.id]);

  if (declared.length === 0) return null;
  if (!terminals.native) {
    return <p className="help-p">Secret values are entered in Hivemind.app on the Mac or in the iPhone/iPad app, and kept in Hivemind
      Server's Keychain. Hivemind never stores them.</p>;
  }
  const run = async (work: () => Promise<string[]>) => {
    setBusy(true);
    setError("");
    try { setStored(await work()); } catch (failure) { setError(secretsErrorText(failure)); } finally { setBusy(false); }
  };
  const unused = (stored ?? []).filter(name => !declared.includes(name));
  return (
    <fieldset className="template-secrets">
      <legend>Secret values</legend>
      <p className="help-p">Kept by Hivemind Server in the macOS Keychain and handed only to the workers it launches. They are never
        shown again.</p>
      {!connected && <p className="help-p" role="status">Connecting to Hivemind Server…</p>}
      {error && <p className="err" role="alert">{error}</p>}
      {declared.map(name => {
        const saved = stored?.includes(name) ?? false;
        const draft = drafts[name] ?? "";
        const problem = draft ? templateSecretValueProblem(draft) : null;
        return (
          <div key={name} className="template-secret">
            <label>
              {name} <small>{stored === null ? "" : saved ? "saved" : "not set"}</small>
              <input className="mono" type="password" value={draft} autoComplete="off" autoCapitalize="off" autoCorrect="off"
                spellCheck={false} data-1p-ignore="true" data-lpignore="true" aria-label={`Value of ${name}`}
                aria-invalid={problem ? true : undefined}
                placeholder={saved ? "enter a new value to replace it" : "value"}
                onChange={event => setDrafts(old => ({ ...old, [name]: event.target.value }))} />
            </label>
            {problem && <p className="err">{problem}</p>}
            <button type="button" className="btn" disabled={busy || !connected || !draft || Boolean(problem)} aria-label={`Save ${name}`}
              onClick={() => void run(async () => {
                const names = await hub!.setTemplateSecret(template.id, name, draft);
                setDrafts(old => ({ ...old, [name]: "" }));
                return names;
              })}>Save</button>
            {saved && (
              <button type="button" className="btn btn-danger" disabled={busy || !connected} aria-label={`Remove ${name}`}
                onClick={() => void run(() => hub!.deleteTemplateSecrets(template.id, name))}>Remove</button>
            )}
          </div>
        );
      })}
      {unused.length > 0 && (
        <p className="help-p">
          Also kept for names this template no longer declares: {unused.join(", ")}.{" "}
          <button type="button" className="text-btn" disabled={busy || !connected}
            onClick={() => void run(async () => {
              let names = stored ?? [];
              for (const name of unused) names = await hub!.deleteTemplateSecrets(template.id, name);
              return names;
            })}>Remove them</button>
        </p>
      )}
    </fieldset>
  );
}

function TemplateEditor({ project, editing, busy, onBusy, onCancel, onSaved }: {
  project: Project;
  editing: Editing;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [slug, setSlug] = useState(editing.slug);
  const [spec, setSpec] = useState(editing.spec);
  const [envText, setEnvText] = useState(() => environmentText(editing.spec.environment));
  const [secretsText, setSecretsText] = useState(() => editing.spec.secretNames.join("\n"));
  const [error, setError] = useState("");
  const parsedEnv = useMemo(() => parseLaunchEnvironment(envText), [envText]);
  const draft: WorkerTemplateSpec = { ...spec, environment: parsedEnv.environment, secretNames: secretNamesFrom(secretsText) };
  const preview = templateCommandPreview(draft, project);
  const set = (patch: Partial<WorkerTemplateSpec>) => setSpec(old => ({ ...old, ...patch }));
  const canSave = !busy && slug.trim() && spec.label.trim() && spec.description.trim() && parsedEnv.errors.length === 0 && preview.ok;

  const save = async () => {
    onBusy(true);
    setError("");
    try {
      if (editing.template) await api.updateWorkerTemplate(editing.template.id, { expectedRevision: editing.template.revision, slug: slug.trim(), spec: draft });
      else await api.createWorkerTemplate(project.slug, { slug: slug.trim(), spec: draft });
      onSaved();
    } catch (failure) {
      setError(String((failure as Error).message || failure));
    } finally {
      onBusy(false);
    }
  };

  return (
    <form className="template-editor" aria-label={editing.template ? `Edit ${editing.template.spec.label}` : "New worker template"}
      onSubmit={event => { event.preventDefault(); if (canSave) void save(); }}>
      <label>
        Name
        <input value={spec.label} maxLength={80} onChange={event => set({ label: event.target.value })} placeholder="Codex senior" autoFocus />
      </label>
      <label>
        Slug
        <input className="mono" value={slug} maxLength={32} onChange={event => setSlug(event.target.value.toLowerCase())}
          placeholder="codex-senior" autoComplete="off" spellCheck={false} />
      </label>
      <label>
        When to use it
        <textarea rows={2} value={spec.description} maxLength={500} onChange={event => set({ description: event.target.value })}
          placeholder="Shown to brains: which tasks this worker suits" />
      </label>
      <label>
        Software
        <input className="mono" value={spec.software} onChange={event => set({ software: event.target.value })}
          placeholder="codex2, opencode-hm, claude…" autoComplete="off" spellCheck={false} />
      </label>
      <ModelSelect software={spec.software} model={spec.model} effort={spec.effort}
        onChange={next => set({ model: next.model, effort: next.effort as WorkerTemplateSpec["effort"] })} />
      <label>
        CLI flags
        <input className="mono" value={spec.extraFlags} onChange={event => set({ extraFlags: event.target.value })}
          placeholder="optional, e.g. --auto" autoComplete="off" spellCheck={false} />
      </label>
      <fieldset className="launch-seg">
        <legend>Seniority</legend>
        <div className="seg">
          {(["senior", "mid", "junior"] as const).map(value => (
            <label key={value} className={spec.seniority === value ? "on" : ""}>
              <input type="radio" className="sr-only" name="template-seniority" value={value} checked={spec.seniority === value}
                onChange={() => set({ seniority: value as Seniority })} />
              {value}
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        Focus
        <input value={spec.focus} maxLength={80} onChange={event => set({ focus: event.target.value })} placeholder="optional, e.g. frontend" />
      </label>
      <label>
        At most at once
        <input type="number" min={1} max={8} step={1} value={spec.maxConcurrent}
          onChange={event => set({ maxConcurrent: Math.max(1, Math.min(8, Math.trunc(Number(event.target.value) || 1))) })} />
      </label>
      <label className="launch-env">
        Environment variables
        <textarea className="mono" rows={3} value={envText} onChange={event => setEnvText(event.target.value)}
          placeholder={"optional — one NAME=value per line"} autoComplete="off" spellCheck={false}
          aria-invalid={parsedEnv.errors.length ? true : undefined} />
      </label>
      {parsedEnv.errors.length > 0 && (
        <p className="err" role="alert">{parsedEnv.errors.map((line, i) => <span key={i}>{i > 0 && <br />}{line}</span>)}</p>
      )}
      <label>
        Secret names
        <textarea className="mono" rows={2} value={secretsText} onChange={event => setSecretsText(event.target.value)}
          placeholder={"optional — one per line, e.g. OPENCODE_API_KEY"} autoComplete="off" spellCheck={false} />
      </label>
      {editing.template
        ? <SecretValues template={editing.template} />
        : <p className="help-p">Only the names are saved with the template. Save it, then enter their values here.</p>}
      <label className="check">
        <input type="checkbox" checked={spec.enabled} onChange={event => set({ enabled: event.target.checked })} />
        Brains may use this template
      </label>
      <section className="launch-preview" aria-label="Command preview">
        <header><span>Command preview</span></header>
        {preview.ok ? <pre className="launch-pre">{preview.text}</pre> : <p className="err">{preview.error}</p>}
        <p className="help-p">Hivemind adds the prompt that joins the worker to its task when a brain launches it.</p>
      </section>
      {error && <p className="err" role="alert">{error}</p>}
      <div className="row">
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={!canSave}>{busy ? "Saving…" : "Save template"}</button>
      </div>
    </form>
  );
}
