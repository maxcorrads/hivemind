import { ArrowLeft, Copy, Play, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Agent, Project } from "../src/shared/types.ts";
import { buildLaunchCommand, codexSessionTitle, launchBlockText, projectLaunchTools, type LaunchContext } from "../src/shared/launch-prompt.ts";
import type { WorkerTemplate } from "../src/shared/worker-templates.ts";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { inNativeApp, onMacDesktop, terminalSessionLaunchProblem } from "./native-bridge.ts";
import { SessionsSheet } from "./SessionsSheet.tsx";
import { TerminalNotice } from "./TerminalNotice.tsx";
import { terminalBlocker, terminalHub, useTerminalState } from "./use-terminal.ts";

/** Stands in for the ticket in the preview: the real one exists only once Start reserves the worker. */
const PREVIEW_TICKET = `hmc_${"0".repeat(48)}`;

/** The command a reserved worker's launch runs: the template's CLI with a prompt that joins it with its ticket. */
export function templateLaunch(template: WorkerTemplate, project: Project, context: LaunchContext | undefined, workspacePath: string,
  claim: { ticket: string; name: string }) {
  return buildLaunchCommand({
    software: template.spec.software, model: template.spec.model, effort: template.spec.effort, extraFlags: template.spec.extraFlags,
    ...projectLaunchTools(context, project, "worker"), workspacePath, cdWorktree: Boolean(workspacePath.trim()), projectSlug: project.slug,
    hiveName: project.name, passProject: true, role: "worker", seniority: template.spec.seniority, focus: template.spec.focus || null,
    adoptUntrusted: true, claim: claim.ticket, claimName: claim.name,
  });
}

/**
 * Launch agent → From a template: Human reserves a worker from one of the project's templates, named after the task,
 * and starts it (the apps) or copies its command (a browser). The template's secrets reach it only from the apps.
 */
export function TemplateLaunchSheet({ projects, agents, defaultProject, onBack, onClose }: {
  projects: Project[];
  agents: Agent[];
  defaultProject: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const [native] = useState(() => inNativeApp());
  const terminals = useTerminalState();
  const terminalApp = native && onMacDesktop(terminals.platform);
  const [projectSlug, setProjectSlug] = useState(defaultProject);
  const project = projects.find(item => item.slug === projectSlug) ?? projects[0];
  const [templates, setTemplates] = useState<WorkerTemplate[] | null>(null);
  const [context, setContext] = useState<LaunchContext | undefined>();
  const [templateId, setTemplateId] = useState("");
  const [label, setLabel] = useState("");
  const [workspacePath, setWorkspacePath] = useState(project?.worktree ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [started, setStarted] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!project) return;
    let active = true;
    setTemplates(null);
    setContext(undefined);
    setError("");
    setWorkspacePath(project.worktree ?? "");
    api.workerTemplates(project.slug).then(result => {
      if (!active) return;
      const usable = result.templates.filter(item => item.spec.enabled);
      setTemplates(usable);
      setTemplateId(old => usable.some(item => item.id === old) ? old : usable[0]?.id ?? "");
    }).catch(failure => { if (active) setError(String(failure.message || failure)); });
    api.launchContext(project.slug).then(next => { if (active) setContext(next); })
      .catch(failure => { if (active) setError(String(failure.message || failure)); });
    return () => { active = false; };
  }, [project?.id]);

  const template = templates?.find(item => item.id === templateId);
  const running = template ? agents.filter(agent => agent.templateId === template.id && agent.removedAt === undefined).length : 0;
  const full = template ? running >= template.spec.maxConcurrent : false;
  const preview = useMemo(() => {
    if (!template || !project) return null;
    try {
      return { ok: true as const, text: launchBlockText(templateLaunch(template, project, context, workspacePath,
        { ticket: PREVIEW_TICKET, name: "<assigned name>" }), template.spec.environment) };
    } catch (failure) {
      return { ok: false as const, error: String((failure as Error).message || failure) };
    }
  }, [template, project, context, workspacePath]);
  const blocker = native ? terminalBlocker(terminals) : null;
  const canStart = Boolean(template && project && preview?.ok && !full && !busy && (!native || !blocker));

  /** Reserves the worker, then starts it in tmux (the apps) or copies its command. */
  const go = async (openInTerminal: boolean | null) => {
    if (!template || !project) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { agent, ticket } = await api.reserveWorker(template.id, label.trim() || null);
      const launch = templateLaunch(template, project, context, workspacePath, { ticket, name: agent.name });
      const environment = Object.keys(template.spec.environment).length ? template.spec.environment : undefined;
      if (openInTerminal === null) {
        await navigator.clipboard.writeText(launchBlockText(launch, environment));
        setNotice(`${agent.name} is reserved; paste the copied command in a terminal within 30 minutes.` +
          (template.spec.secretNames.length ? " Its secrets are passed only when it is started from Hivemind.app or the iPhone app." : ""));
        return;
      }
      const hub = terminalHub();
      const item = { project: project.slug, agent: agent.name, title: codexSessionTitle(project.name, agent.name) || agent.name, ...launch,
        ...(environment ? { environment } : {}), template: template.id };
      const problem = terminalSessionLaunchProblem([item]);
      if (!hub || problem) throw new Error(problem ?? "Terminals are available only in Hivemind.app");
      const result = await hub.launch([item], openInTerminal);
      if (result.errors.length) throw new Error(result.errors.map(item => item.message).join("\n"));
      if (terminalApp) setNotice(`Started ${agent.name}.`);
      else setStarted(result.names[0] ?? null);
    } catch (failure) {
      setError(`${String((failure as Error).message || failure)} A worker already reserved gives up after 30 minutes.`);
    } finally {
      setBusy(false);
    }
  };

  if (started !== undefined) return <SessionsSheet agents={agents} projects={projects} onClose={onClose} initialSession={started} />;

  return (
    <Modal onClose={() => { if (!busy) onClose(); }}>
      <div className="sheet sheet-wide launch-sheet" role="dialog" aria-modal="true" aria-label="Launch from a template"
        onClick={event => event.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="icon-btn" aria-label="Back to Launch agent" title="Back" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <div>
            <h2>Launch from a template</h2>
            <p>A worker for one task, from the project's worker templates. It is named after the task and joins with a one-time ticket.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close dialog" title="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="sheet-body">
          <label>
            Project
            <select value={project?.slug ?? ""} onChange={event => setProjectSlug(event.target.value)}>
              {projects.map(item => <option key={item.id} value={item.slug}>{item.name}</option>)}
            </select>
          </label>
          {templates?.length === 0 && (
            <p className="help-p">No enabled worker templates in this project. Add them in Project settings → Worker templates.</p>
          )}
          {templates && templates.length > 0 && (
            <label>
              Template
              <select value={templateId} onChange={event => setTemplateId(event.target.value)}>
                {templates.map(item => <option key={item.id} value={item.id}>{item.spec.label}</option>)}
              </select>
            </label>
          )}
          {template && (
            <p className="help-p">
              {template.spec.description} {running} of at most {template.spec.maxConcurrent} running.
              {full ? " Wait for one to finish, or raise the limit in the template." : ""}
            </p>
          )}
          <label>
            Task
            <input value={label} maxLength={200} onChange={event => setLabel(event.target.value)}
              placeholder="short name, e.g. settings page (becomes part of the worker's name)" />
          </label>
          <label className="launch-workspace">
            Workspace path
            <input className="mono" value={workspacePath} onChange={event => setWorkspacePath(event.target.value)}
              placeholder="optional — where the worker starts" autoComplete="off" spellCheck={false} />
          </label>
          {preview && (preview.ok ? (
            <section className="launch-preview" aria-label="Command preview">
              <header><span>Command preview</span></header>
              <pre className="launch-pre">{preview.text}</pre>
              <p className="help-p">The name and the one-time ticket are filled in when the worker is reserved.</p>
            </section>
          ) : <p className="help-p">{preview.error}</p>)}
          {native && blocker && <TerminalNotice blocker={blocker} compact />}
          {error && <p className="err" role="alert">{error}</p>}
          {notice && <p className="help-p" role="status">{notice}</p>}
        </div>
        <div className="row sheet-footer launch-footer">
          <button type="button" className="launch-close" onClick={onClose}>Close</button>
          <button type="button" className={native ? "btn" : "primary"} disabled={!canStart} onClick={() => void go(null)}>
            <Copy size={14} aria-hidden="true" /> Reserve and copy
          </button>
          {native && (
            <button type="button" className={terminalApp ? "btn" : "primary"} disabled={!canStart} onClick={() => void go(false)}>
              <Play size={14} aria-hidden="true" /> {busy ? "Launching…" : terminalApp ? "Start in background" : "Start on Mac"}
            </button>
          )}
          {terminalApp && (
            <button type="button" className="primary" disabled={!canStart} onClick={() => void go(true)}>
              <SquareTerminal size={14} aria-hidden="true" /> Open in Terminal
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
