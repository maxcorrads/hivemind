import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent, Project } from "../src/shared/types.ts";
import type { WorkerTemplate } from "../src/shared/worker-templates.ts";
import { api, type LaunchRequestView } from "./api.ts";
import { decideLaunch, type LaunchDecision } from "./launch-approval.ts";
import { inNativeApp, notifyNative, reportedNativePlatform } from "./native-bridge.ts";

type LiveEvent = { type: string; payload: unknown };

function eventRequest(payload: unknown): LaunchRequestView | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = ("request" in payload ? payload.request : payload) as Partial<LaunchRequestView> | undefined;
  return candidate && typeof candidate.id === "string" && typeof candidate.projectId === "string" &&
    candidate.state === "awaiting_approval" ? candidate as LaunchRequestView : null;
}

/** Fetches the durable queue on opening/reconnect and after every queue event. Only new live approvals notify. */
export function useLaunchRequests(projects: Project[], agents: Agent[]) {
  const [requests, setRequests] = useState<LaunchRequestView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const notified = useRef(new Set<string>());
  const context = useRef({ projects, agents });
  context.current = { projects, agents };

  const refresh = useCallback(async () => {
    const ticket = ++generation.current;
    try {
      const result = await api.launchRequests();
      if (ticket !== generation.current) return;
      setRequests(result.requests);
      setError(null);
    } catch (failure) {
      if (ticket === generation.current) setError(String((failure as Error).message || failure));
    } finally {
      if (ticket === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);

  const onLiveEvent = useCallback((event: LiveEvent) => {
    if (event.type === "hello") { void refresh(); return; }
    if (event.type !== "launch-requests") return;
    const request = eventRequest(event.payload);
    // Server.app owns macOS approval notifications even when the UI window is closed.
    if (request && inNativeApp() && reportedNativePlatform() === "ios" && !notified.current.has(request.id)) {
      notified.current.add(request.id);
      const project = context.current.projects.find(item => item.id === request.projectId);
      const brain = context.current.agents.find(item => item.id === request.brainId);
      const detail = request.reason?.trim();
      notifyNative({ title: `Worker approval · ${project?.name ?? "Hivemind"}`,
        body: `${brain?.name ?? "A brain"} requests a worker${detail ? `: ${detail.slice(0, 140)}` : "."}`,
        tag: `launch-${request.id}`, target: { kind: "inbox", project: project?.slug ?? "" } });
    }
    void refresh();
  }, [refresh]);

  const decide = useCallback(async (request: LaunchRequestView, action: LaunchDecision, templateId?: string) => {
    try {
      await decideLaunch(request.id, action, templateId);
    } finally {
      // A timeout does not prove refusal: the native app may have committed before its answer was lost.
      await refresh();
    }
  }, [refresh]);
  return { requests, error, loading, refresh, onLiveEvent, decide };
}

export function LaunchRequests({ requests, projects, agents, launcherAvailable, error, loading, onRetry, onDecide,
  native = inNativeApp() }: {
  requests: LaunchRequestView[];
  projects: Project[];
  agents: Agent[];
  launcherAvailable: boolean;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  onDecide: (request: LaunchRequestView, action: LaunchDecision, templateId?: string) => Promise<void>;
  native?: boolean;
}) {
  const pending = requests.filter(request => request.state === "awaiting_approval");
  const [templates, setTemplates] = useState<Record<string, WorkerTemplate[]>>({});
  const [templateErrors, setTemplateErrors] = useState<Record<string, string>>({});
  const [templateRefresh, setTemplateRefresh] = useState(0);
  const projectKey = [...new Set(pending.map(request => request.projectId))].sort().join(":");
  useEffect(() => {
    let active = true;
    for (const id of projectKey.split(":").filter(Boolean)) {
      const project = projects.find(item => item.id === id);
      if (!project) continue;
      setTemplateErrors(current => { const next = { ...current }; delete next[id]; return next; });
      setTemplates(current => { const next = { ...current }; delete next[id]; return next; });
      api.workerTemplates(project.slug).then(result => {
        if (active) {
          setTemplates(current => ({ ...current, [id]: result.templates }));
          setTemplateErrors(current => { const next = { ...current }; delete next[id]; return next; });
        }
      }).catch(failure => {
        if (active) setTemplateErrors(current => ({ ...current, [id]: String((failure as Error).message || failure) }));
      });
    }
    return () => { active = false; };
  }, [projectKey, projects, templateRefresh]);

  if (!pending.length && !error) return null;
  return <section className="launch-requests" aria-label="Launch requests">
    <header className="launch-requests-head">
      <div><h2>Requests{pending.length > 0 ? <span className="inbox-count"> {pending.length}</span> : null}</h2>
        <p>Brains waiting for approval to start a worker.</p></div>
      <button type="button" className="btn" disabled={loading} onClick={() => { setTemplateRefresh(value => value + 1); onRetry(); }}>Refresh</button>
    </header>
    {error && <p className="err" role="alert">Launch requests could not be loaded: {error}</p>}
    {!launcherAvailable && pending.length > 0 && <p className="help-p" role="status">
      Launches need Hivemind Server.app running with its verified server connection.
    </p>}
    {!native && pending.length > 0 && <p className="help-p">Open Hivemind.app on the Mac or the iPhone/iPad app to approve or reject requests.</p>}
    <div className="launch-requests-list">
      {pending.map(request => <LaunchRequestCard key={request.id} request={request}
        project={projects.find(item => item.id === request.projectId)}
        brain={agents.find(item => item.id === request.brainId)}
        worker={agents.find(item => item.id === request.agentId)}
        templates={templates[request.projectId]}
        templateError={templateErrors[request.projectId]}
        native={native} launcherAvailable={launcherAvailable} onDecide={onDecide} />)}
    </div>
  </section>;
}

function LaunchRequestCard({ request, project, brain, worker, templates, templateError, native, launcherAvailable, onDecide }: {
  request: LaunchRequestView;
  project?: Project;
  brain?: Agent;
  worker?: Agent;
  templates?: WorkerTemplate[];
  templateError?: string;
  native: boolean;
  launcherAvailable: boolean;
  onDecide: (request: LaunchRequestView, action: LaunchDecision, templateId?: string) => Promise<void>;
}) {
  const [selectedTemplate, setSelectedTemplate] = useState(request.templateId);
  const [busy, setBusy] = useState<LaunchDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const chosen = templates?.find(template => template.id === selectedTemplate);
  const atCap = request.capBlocked && selectedTemplate === request.templateId;
  const canApprove = native && launcherAvailable && !busy && !done && Boolean(chosen?.spec.enabled) && !atCap;
  const decide = async (action: LaunchDecision) => {
    setBusy(action);
    setError(null);
    try {
      await onDecide(request, action, action === "approve" && selectedTemplate !== request.templateId ? selectedTemplate : undefined);
      setDone(true);
    } catch (failure) {
      setError(String((failure as Error).message || failure));
    } finally {
      setBusy(null);
    }
  };
  return <article className="launch-request-card" aria-label={`Launch request for ${worker?.name ?? project?.name ?? "worker"}`}>
    <div className="launch-request-context"><strong>{project?.name ?? "Unknown project"}</strong><span>·</span>
      <span>{brain?.name ?? "Brain"} requests {worker?.name ?? "a worker"}</span>
      <time dateTime={new Date(request.requestedAt).toISOString()} title={new Date(request.requestedAt).toLocaleString()}>
        {new Date(request.requestedAt).toLocaleDateString()}</time></div>
    {request.reason && <p className="launch-request-reason">{request.reason}</p>}
    {native && <label className="launch-request-template">Change template
      <select value={selectedTemplate} disabled={Boolean(busy) || done || !launcherAvailable || !templates}
        onChange={event => setSelectedTemplate(event.target.value)}>
        {!templates ? <option value={request.templateId}>Loading templates…</option>
          : !templates.some(template => template.id === request.templateId) &&
            <option value={request.templateId}>{request.templateLabel} (unavailable)</option>}
        {templates?.filter(template => template.spec.enabled || template.id === request.templateId).map(template =>
          <option key={template.id} value={template.id} disabled={!template.spec.enabled}>{template.spec.label}</option>)}
      </select>
    </label>}
    {!native && <p className="launch-request-template-name">Template: {templates?.find(item => item.id === request.templateId)?.spec.label ?? request.templateLabel}</p>}
    {templateError && <p className="err" role="alert">Templates could not be loaded: {templateError}</p>}
    {atCap && <p className="launch-request-wait" role="status">At this template's concurrent worker limit. Choose another template or wait for a worker to finish.</p>}
    {error && <p className="err" role="alert">{error}</p>}
    {done && <p role="status">Decision recorded.</p>}
    {native && <div className="launch-request-actions">
      <button type="button" className="primary" disabled={!canApprove} onClick={() => void decide("approve")}>
        {busy === "approve" ? "Approving…" : "Approve"}</button>
      <button type="button" className="btn" disabled={!launcherAvailable || Boolean(busy) || done} onClick={() => void decide("reject")}>
        {busy === "reject" ? "Rejecting…" : "Reject"}</button>
    </div>}
  </article>;
}
