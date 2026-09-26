import { ChevronRight, Copy, Play, SquareTerminal, Terminal, X } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, Project, Seniority } from "../src/shared/types.ts";
import { modelChoiceGroups, parseChoiceId, selectedChoiceId } from "../src/shared/launch-models.ts";
import { api } from "./api.ts";
import { inNativeApp, onMacDesktop, terminalSessionLaunchProblem, type TerminalSessionLaunch } from "./native-bridge.ts";
import { SessionsSheet } from "./SessionsSheet.tsx";
import { TerminalNotice } from "./TerminalNotice.tsx";
import { agentTerminalSession, terminalBlocker, terminalHub, useTerminalState, type TerminalLaunched } from "./use-terminal.ts";
import { projectLaunchTools, type LaunchContext } from "../src/shared/launch-prompt.ts";
import {
  EFFORTS,
  buildLaunchCommand,
  buildRosterPaste,
  codexSessionTitle,
  effectiveSoftware,
  resolveLaunchTune,
  launchBlockText,
  softwareFamily,
  type LaunchRole,
} from "../src/shared/launch-prompt.ts";

const STORE = "hivemind-launch";

type Saved = {
  software: string;
  extraFlags: string;
  softwareUsed: string[];
  model: string;
  effort: string;
  cdWorktree: boolean;
  passProject: boolean;
  adoptUntrusted: boolean;
  role: LaunchRole;
  seniority: Seniority;
  focus: string;
  resume: boolean;
  resumeName: string;
  allHives: boolean;
  tunes: Record<string, { model: string; effort: string }>;
};

const defaults: Saved = {
  software: "codex",
  extraFlags: "",
  softwareUsed: ["codex"],
  model: "",
  effort: "",
  cdWorktree: true,
  passProject: true,
  adoptUntrusted: true,
  role: "brain",
  seniority: "senior",
  focus: "coord",
  resume: false,
  resumeName: "",
  allHives: false,
  tunes: {},
};

function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Saved>;
    const role = parsed.role === "worker" ? "worker" : "brain";
    const seniority =
      parsed.seniority === "junior" || parsed.seniority === "mid" || parsed.seniority === "senior"
        ? parsed.seniority
        : defaults.seniority;
    const softwareUsed = Array.isArray(parsed.softwareUsed)
      ? [...new Set(
          parsed.softwareUsed
            .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
            .map((s) => s.trim()),
        )].slice(0, 12)
      : defaults.softwareUsed;
    const effort =
      typeof parsed.effort === "string" && (EFFORTS as readonly string[]).includes(parsed.effort)
        ? parsed.effort
        : "";
    const tunes: Record<string, { model: string; effort: string }> = {};
    if (parsed.tunes && typeof parsed.tunes === "object") {
      for (const [name, raw] of Object.entries(parsed.tunes)) {
        if (!name || !raw || typeof raw !== "object") continue;
        const model = typeof raw.model === "string" ? raw.model.trim() : "";
        const seatEffort =
          typeof raw.effort === "string" && (EFFORTS as readonly string[]).includes(raw.effort) ? raw.effort : "";
        tunes[name] = { model, effort: seatEffort };
      }
    }
    return {
      ...defaults,
      software: typeof parsed.software === "string" && parsed.software.trim() ? parsed.software.trim() : "codex",
      extraFlags: typeof parsed.extraFlags === "string" ? parsed.extraFlags : "",
      softwareUsed: softwareUsed.length ? softwareUsed : defaults.softwareUsed,
      model: typeof parsed.model === "string" ? parsed.model.trim() : "",
      effort,
      cdWorktree: parsed.cdWorktree !== false,
      passProject: parsed.passProject !== false,
      adoptUntrusted: parsed.adoptUntrusted !== false,
      role,
      seniority,
      focus: typeof parsed.focus === "string" ? parsed.focus : defaults.focus,
      resume: parsed.resume === true,
      resumeName: typeof parsed.resumeName === "string" ? parsed.resumeName : "",
      allHives: parsed.allHives === true,
      tunes,
    };
  } catch {
    return defaults;
  }
}

function persist(next: Saved) {
  try {
    localStorage.setItem(STORE, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fallback */
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.left = "-9999px";
  document.body.appendChild(el);
  el.select();
  const ok = document.execCommand("copy");
  el.remove();
  if (!ok) throw new Error("Could not copy");
}

function ModelSelect({
  software,
  model,
  effort,
  inherit,
  onChange,
}: {
  software: string;
  model: string;
  effort: string;
  inherit?: string;
  onChange: (next: { model: string; effort: string }) => void;
}) {
  const alias = effectiveSoftware(software);
  const groups = modelChoiceGroups(alias);
  const value = selectedChoiceId(alias, model, effort);
  const known = new Set(groups.flatMap((g) => g.choices.map((c) => c.id)));
  const extraEffort = softwareFamily(alias) === "cursor" ? "" : effort;
  return (
    <label>
      Model
      <select
        value={value}
        onChange={(e) => {
          const id = e.target.value;
          if (!id) {
            onChange({ model: "", effort: "" });
            return;
          }
          const hit = groups.flatMap((g) => g.choices).find((c) => c.id === id);
          onChange(hit ? { model: hit.model, effort: hit.effort } : parseChoiceId(id));
        }}
      >
        <option value="">{inherit ? `same as above (${inherit})` : "default"}</option>
        {value && !known.has(value) && (
          <option value={value}>{extraEffort ? `${model} · ${extraEffort}` : model}</option>
        )}
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.choices.map((choice) => (
              <option key={`${group.label}:${choice.id}`} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

export function LaunchSheet({
  projects,
  agents,
  defaultProject,
  onClose,
}: {
  projects: Project[];
  agents: Agent[];
  defaultProject: string;
  onClose: () => void;
}) {
  const [initial] = useState(loadSaved);
  // Hivemind.app registers the bridge before the page loads, so this never changes.
  const [native] = useState(() => inNativeApp());
  const [software, setSoftware] = useState(initial.software);
  const [extraFlags, setExtraFlags] = useState(initial.extraFlags);
  const [softwareUsed, setSoftwareUsed] = useState(initial.softwareUsed);
  const [model, setModel] = useState(initial.model);
  const [effort, setEffort] = useState(initial.effort);
  const [projectSlug, setProjectSlug] = useState(defaultProject);
  const [workspacePath, setWorkspacePath] = useState("");
  const [pathDirty, setPathDirty] = useState(false);
  const [cdWorktree, setCdWorktree] = useState(initial.cdWorktree);
  const [passProject, setPassProject] = useState(initial.passProject);
  const [adoptUntrusted, setAdoptUntrusted] = useState(initial.adoptUntrusted);
  const [role, setRole] = useState<LaunchRole>(initial.role);
  const [seniority, setSeniority] = useState<Seniority>(initial.seniority);
  const [focus, setFocus] = useState(initial.focus);
  const [resume, setResume] = useState(initial.resume);
  const [allHives, setAllHives] = useState(initial.allHives);
  const [tunes, setTunes] = useState<Record<string, { model: string; effort: string }>>(initial.tunes);
  const [copied, setCopied] = useState<string | null>(null);
  const terminals = useTerminalState();
  // Terminal.app is the Mac's. The iPhone/iPad app starts sessions on the Mac and shows them in the page instead.
  const terminalApp = native && onMacDesktop(terminals.platform);
  // Off the Mac, after a launch: the sheet gives way to the sessions, opened on the one it started.
  const [started, setStarted] = useState<{ session: string | null } | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchNote, setLaunchNote] = useState<{ error: boolean; text: string } | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const [contexts, setContexts] = useState<Record<string, LaunchContext>>({});
  const [contextErrors, setContextErrors] = useState<Record<string, string>>({});
  const launchContext = contexts[projectSlug];
  const contextError = contextErrors[projectSlug];
  useEffect(() => {
    let active = true;
    setContexts({});
    setContextErrors({});
    for (const project of projects) {
      api.launchContext(project.slug)
        .then((context) => { if (active) setContexts((old) => ({ ...old, [project.slug]: context })); })
        .catch((error) => { if (active) setContextErrors((old) => ({ ...old, [project.slug]: String(error.message || error) })); });
    }
    return () => { active = false; };
  }, [projects.map((p) => p.id + ":" + p.slug).join("|")]);

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);

  useEffect(() => {
    setProjectSlug(defaultProject);
    setPathDirty(false);
  }, [defaultProject]);

  const project = projects.find((p) => p.slug === projectSlug) ?? projects[0];
  const hiveName = project?.name ?? "";
  const registeredPath = project?.worktree ?? "";

  useEffect(() => {
    if (!pathDirty) setWorkspacePath(registeredPath);
  }, [registeredPath, pathDirty]);

  const roster = useMemo(() => {
    const slug = project?.slug ?? projectSlug;
    return agents
      .filter((a) => a.role === "brain" || a.role === "worker")
      .filter((a) => allHives || a.project === slug)
      .slice()
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === "brain" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [agents, allHives, project, projectSlug]);

  const shared = {
    software,
    extraFlags,
    model,
    effort,
    cdWorktree,
    passProject,
    adoptUntrusted,
  };

  const built = useMemo(() => {
    try {
      if (contextError) throw new Error(contextError);
      const launch = buildLaunchCommand({
        ...shared,
        ...projectLaunchTools(launchContext, project ?? projects.find((p) => p.slug === projectSlug), role),
        workspacePath,
        projectSlug: project?.slug ?? projectSlug,
        hiveName,
        role,
        seniority: role === "worker" ? seniority : null,
        focus,
        resume: false,
      });
      return { ok: true as const, launch, text: launchBlockText(launch) };
    } catch (e) {
      return { ok: false as const, error: String((e as Error).message || e) };
    }
  }, [software, extraFlags, model, effort, workspacePath, cdWorktree, project, projects, projectSlug, hiveName, passProject, role, seniority, focus, adoptUntrusted, launchContext, contextError]);

  const resumeBlocks = useMemo(() => {
    return roster.map((agent) => {
      const hive = projects.find((p) => p.slug === agent.project);
      const selectedSlug = project?.slug ?? projectSlug;
      const path =
        pathDirty && hive?.slug === selectedSlug
          ? workspacePath
          : (hive?.worktree ?? (hive?.slug === selectedSlug ? workspacePath : ""));
      const seat = resolveLaunchTune({ model, effort }, tunes[agent.name]);
      try {
        if (agent.role !== "brain" && agent.role !== "worker") {
          return { agent, hive, ok: false as const, error: "not an agent", text: "" };
        }
        if (contextErrors[hive?.slug ?? ""]) throw new Error(contextErrors[hive!.slug]);
        const launch = buildLaunchCommand({
          ...shared,
          ...projectLaunchTools(contexts[hive?.slug ?? ""], hive, agent.role),
          model: seat.model,
          effort: seat.effort,
          workspacePath: path,
          projectSlug: hive?.slug ?? agent.project ?? projectSlug,
          hiveName: hive?.name ?? "",
          role: agent.role,
          seniority: agent.role === "worker" ? agent.seniority : null,
          focus: agent.focus,
          resume: true,
          resumeName: agent.name,
        });
        return { agent, hive, ok: true as const, launch, text: launchBlockText(launch) };
      } catch (e) {
        return { agent, hive, ok: false as const, error: String((e as Error).message || e), text: "" };
      }
    });
  }, [roster, projects, project, projectSlug, pathDirty, workspacePath, software, extraFlags, model, effort, tunes, cdWorktree, passProject, adoptUntrusted, contexts, contextErrors]);

  const remember = (patch: Partial<Saved> = {}) => {
    const next: Saved = {
      software: (patch.software ?? software).trim() || "codex",
      extraFlags: patch.extraFlags ?? extraFlags,
      softwareUsed: patch.softwareUsed ?? softwareUsed,
      model: patch.model ?? model,
      effort: patch.effort ?? effort,
      cdWorktree: patch.cdWorktree ?? cdWorktree,
      passProject: patch.passProject ?? passProject,
      adoptUntrusted: patch.adoptUntrusted ?? adoptUntrusted,
      role: patch.role ?? role,
      seniority: patch.seniority ?? seniority,
      focus: patch.focus ?? focus,
      resume: patch.resume ?? resume,
      resumeName: "",
      allHives: patch.allHives ?? allHives,
      tunes: patch.tunes ?? tunes,
    };
    persist(next);
  };

  const setTune = (name: string, patch: Partial<{ model: string; effort: string }>) => {
    const next = {
      ...tunes,
      [name]: { model: tunes[name]?.model ?? "", effort: tunes[name]?.effort ?? "", ...patch },
    };
    setTunes(next);
    remember({ tunes: next });
  };

  const rememberSoftware = () => {
    const name = software.trim() || "codex";
    const used = [name, ...softwareUsed.filter((s) => s !== name)].slice(0, 12);
    setSoftwareUsed(used);
    remember({ software: name, softwareUsed: used });
  };

  const markCopied = (key: string) => {
    setCopied(key);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => {
      copiedTimer.current = null;
      setCopied((cur) => (cur === key ? null : cur));
    }, 1600);
  };

  const onCopy = async (text: string, key: string) => {
    try {
      await copyText(text);
    } catch {
      return;
    }
    rememberSoftware();
    markCopied(key);
  };

  const seatTitle = (hive: string, agent: string) => codexSessionTitle(hive, agent) || agent;
  const allText = buildRosterPaste(
    resumeBlocks
      .filter((b) => b.ok)
      .map((b) => ({
        title: seatTitle(b.hive?.name ?? "", b.agent.name),
        text: b.text,
      })),
  );

  const canCopyOne = built.ok && projects.length > 0;
  const canCopyAll = resume && resumeBlocks.length > 0 && resumeBlocks.every((b) => b.ok);

  // Hivemind.app only: the same launches as the copied text, each in its own tmux session (reused when that
  // employee's is still running), optionally with a Terminal window attached.
  const terminalLaunches: TerminalSessionLaunch[] = resume
    ? (canCopyAll ? resumeBlocks.flatMap((b) => b.ok ? [{
        project: b.hive?.slug ?? b.agent.project ?? projectSlug, agent: b.agent.name,
        title: seatTitle(b.hive?.name ?? "", b.agent.name), ...b.launch,
        // The session this employee already runs in, even one named hm-<project>-new-<n>, is reused.
        session: agentTerminalSession(b.agent),
      }] : []) : [])
    : (canCopyOne && built.ok ? [{ project: project?.slug ?? projectSlug, agent: null, title: seatTitle(hiveName, `new ${role}`), ...built.launch }] : []);
  const terminalBlock = native ? terminalBlocker(terminals) : null;
  const terminalProblem = terminalBlock?.message ?? (terminalLaunches.length ? terminalSessionLaunchProblem(terminalLaunches) : null);
  const canLaunchTerminal = native && terminalLaunches.length > 0 && !terminalProblem && !launching;
  const many = terminalLaunches.length > 1;
  const terminalKey = resume ? "terminal-all" : "terminal-one";
  const backgroundKey = resume ? "background-all" : "background-one";
  const terminalLabel = copied === terminalKey ? "Opened" : many ? `Open ${terminalLaunches.length} terminals` : "Open in Terminal";
  const backgroundLabel = !terminalApp ? (launching ? "Launching…" : many ? `Start ${terminalLaunches.length} on Mac` : "Start on Mac")
    : copied === backgroundKey ? "Started" : many ? `Start ${terminalLaunches.length} in background` : "Start in background";
  const describeLaunch = (launches: TerminalSessionLaunch[], result: TerminalLaunched) => {
    if (result.errors.length) {
      return { error: true, text: result.errors.map((e) => `${launches[e.index]?.title ?? "Launch"}: ${e.message}`).join("\n") };
    }
    const reused = result.names.filter((name) => name && !result.created.includes(name)).length;
    if (!reused) return null;
    return { error: false, text: reused === result.names.length
      ? (many ? "All of them were already running; nothing was started again." : "Already running; nothing was started again.")
      : `${reused} already running; only the others were started.` };
  };
  const onLaunchTerminal = (openInTerminal: boolean) => {
    const hub = terminalHub();
    if (!canLaunchTerminal || !hub) return;
    const launches = terminalLaunches;
    setLaunching(true);
    setLaunchNote(null);
    rememberSoftware();
    hub.launch(launches, openInTerminal)
      .then((result) => {
        const note = describeLaunch(launches, result);
        setLaunchNote(note);
        if (note?.error) return;
        if (!terminalApp) {
          // One session opens in its terminal; several open the list, each a tap away.
          const names = result.names.filter((name): name is string => name !== null);
          setStarted({ session: names.length === 1 ? names[0]! : null });
          return;
        }
        markCopied(openInTerminal ? terminalKey : backgroundKey);
      })
      .catch((error: Error) => setLaunchNote({ error: true, text: error.message }))
      .finally(() => setLaunching(false));
  };

  const chooseRole = (next: LaunchRole) => {
    const nextFocus =
      next === "brain" && focus === "frontend"
        ? "coord"
        : next === "worker" && focus === "coord"
          ? "frontend"
          : focus;
    setRole(next);
    if (nextFocus !== focus) setFocus(nextFocus);
    remember({ role: next, focus: nextFocus });
  };
  // The closed Advanced disclosure still says what the launch will do.
  const advancedSummary = [
    cdWorktree && "cd into workspace",
    passProject && "pass project",
    adoptUntrusted && "trust hive mail",
    extraFlags.trim() && "extra flags",
  ].filter(Boolean).join(" · ") || "defaults off";

  if (started) {
    return <SessionsSheet agents={agents} projects={projects} onClose={onClose} initialSession={started.session} />;
  }

  return (
    <Modal onClose={onClose}>
      <div className="sheet sheet-wide launch-sheet" role="dialog" aria-modal="true" aria-label="Launch agent" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <span className="sheet-icon" aria-hidden="true"><Terminal size={18} /></span>
          <div>
            <h2>Launch agent</h2>
            <p>
              {terminalApp
                ? "Choose an agent, then start it in its own tmux session, or copy its launch command. One session = one employee."
                : native
                ? "Choose an agent, then start it in its own tmux session on your Mac, or copy its launch command. One session = one employee."
                : "Choose an agent, then paste its launch command into a new terminal. One terminal = one employee."}
            </p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close dialog" title="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="sheet-body">
          <label>
            Project
            <select
              value={project?.slug ?? projectSlug}
              onChange={(e) => {
                setProjectSlug(e.target.value);
                setPathDirty(false);
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {!resume && (
            <fieldset className="launch-seg">
              <legend>Role</legend>
              <div className="seg">
                {(["brain", "worker"] as const).map((value) => (
                  <label key={value} className={role === value ? "on" : ""}>
                    <input type="radio" className="sr-only" name="launch-role" value={value} checked={role === value}
                      onChange={() => chooseRole(value)} />
                    {value}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <label>
            Software
            <input
              className="mono"
              list="launch-software"
              value={software}
              onChange={(e) => setSoftware(e.target.value)}
              onBlur={() => remember()}
              placeholder="codex"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </label>
          <datalist id="launch-software">
            {softwareUsed.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <ModelSelect
            software={software}
            model={model}
            effort={effort}
            onChange={(next) => {
              setModel(next.model);
              setEffort(next.effort);
              remember({ model: next.model, effort: next.effort });
            }}
          />
          {!resume && (
            <>
              {role === "worker" && (
                <fieldset className="launch-seg">
                  <legend>Seniority</legend>
                  <div className="seg">
                    {(["senior", "mid", "junior"] as const).map((value) => (
                      <label key={value} className={seniority === value ? "on" : ""}>
                        <input type="radio" className="sr-only" name="launch-seniority" value={value} checked={seniority === value}
                          onChange={() => {
                            setSeniority(value);
                            remember({ seniority: value });
                          }} />
                        {value}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <label>
                Focus
                <input
                  value={focus}
                  onChange={(e) => setFocus(e.target.value)}
                  onBlur={() => remember()}
                  placeholder={role === "brain" ? "coord" : "frontend"}
                />
              </label>
            </>
          )}
          <label className="launch-workspace">
            Workspace path
            <input
              className="mono"
              value={workspacePath}
              onChange={(e) => {
                setWorkspacePath(e.target.value);
                setPathDirty(true);
              }}
              placeholder={registeredPath || "optional — where the agent starts"}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <details className="settings-disclosure sheet-disclosure">
            <summary>
              <ChevronRight size={14} aria-hidden="true" />
              <span>Advanced launch options</span>
              <small>{advancedSummary}</small>
            </summary>
          <label>
            CLI flags
            <input
              className="mono"
              value={extraFlags}
              onChange={(e) => setExtraFlags(e.target.value)}
              onBlur={() => remember()}
              placeholder="optional"
              autoComplete="off"
            />
          </label>
          <fieldset className="checks">
            <legend>Launch</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={cdWorktree}
                onChange={(e) => {
                  setCdWorktree(e.target.checked);
                  remember({ cdWorktree: e.target.checked });
                }}
              />
              cd into workspace path
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={passProject}
                onChange={(e) => {
                  setPassProject(e.target.checked);
                  remember({ passProject: e.target.checked });
                }}
              />
              pass project on join
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={adoptUntrusted}
                onChange={(e) => {
                  setAdoptUntrusted(e.target.checked);
                  remember({ adoptUntrusted: e.target.checked });
                }}
              />
              treat hive mail as my authorization
            </label>
          </fieldset>
          {adoptUntrusted && (
            <p className="help-p">
              The first lines tell this CLI session it may trust Human and brain mail from Hivemind. They are in the block only if you mean that.
            </p>
          )}
          {resume && allHives && pathDirty && (
            <p className="help-p">
              The path override applies only to the selected hive. Other hives keep their registered worktree.
            </p>
          )}
          {cdWorktree && !workspacePath.trim() && (
            <p className="help-p">
              {resume
                ? "No workspace path for this hive — commands start here unless that employee’s hive has its own worktree. Set a path above or in hive settings."
                : "No workspace path — the command starts here. Set a path above or in hive settings."}
            </p>
          )}
          </details>
          <details className="settings-disclosure sheet-disclosure">
            <summary>
              <ChevronRight size={14} aria-hidden="true" />
              <span>Connection and launch instructions</span>
            </summary>
          <p className="help-p" role="status">
            {contextError ? "Cannot load Hivemind connection: " + contextError : !launchContext ? "Loading Hivemind connection…" :
              role === "worker" ? "Hivemind connection ready. Workers do not need project plugin instructions." :
              launchContext.pluginError ? "Cannot load project tools: " + launchContext.pluginError :
              "Project plugins: " + (launchContext.plugins.map((p) => p.name).join(", ") || "none enabled") + ". Instructions are included; no tool is started here."}
          </p>
          {launchContext && softwareFamily(software) !== "claude" && <p className="help-p">
            Use this CLI’s normal Hivemind MCP configuration. Automatic server binding is available for Claude launchers.
          </p>}
          <p className="help-p">
            One block: command plus prompt. Paste it in a terminal. One chat is one employee. Hive is the Hivemind project name.
          </p>
          {softwareFamily(software) === "codex" && (
            <p className="help-p">
              Codex has no session-name flag at open. After join, type{" "}
              <code>/rename {hiveName ? `${hiveName} - ` : ""}Name</code> in the TUI — the copied prompt includes that command
              {resume ? " with the employee name." : " once join returns the assigned name."}
            </p>
          )}
          {softwareFamily(software) === "opencode" && (
            <p className="help-p">
              OpenCode TUI takes <code>--prompt</code>, not a positional path. It has no{" "}
              <code>--variant</code> flag — use the last effort you picked for that model in OpenCode.
            </p>
          )}
          </details>
          {resume ? (
            roster.length === 0 ? (
              <p className="help-p">
                {allHives ? "No brains or workers yet." : "No brains or workers in this hive yet."}
              </p>
            ) : (
              <>
                <p className="help-p">
                  The model at the top (with effort in the name) applies to everyone. Override it on a card if that employee should differ.
                  Copy all pastes a zsh script that opens one macOS Terminal window per employee (title Hive - Name). macOS may ask to control Terminal the first time.
                  {native && " Open terminals starts each employee in its own tmux session instead (an employee whose session still runs keeps it) and opens a Terminal window on each."}
                </p>
                {resumeBlocks.map((block) => (
                  <article key={block.agent.id} className="launch-card">
                    <div className="launch-card-h">
                      <strong>{block.agent.name}</strong>
                      <span>
                        {block.agent.role}
                        {block.agent.seniority ? ` · ${block.agent.seniority}` : ""}
                        {block.agent.focus ? ` · ${block.agent.focus}` : ""}
                        {block.hive?.name ? ` · ${block.hive.name}` : ""}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={!block.ok}
                        onClick={() => void onCopy(block.text, block.agent.id)}
                      >
                        <Copy size={13} aria-hidden="true" />
                        {copied === block.agent.id ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <ModelSelect
                      software={software}
                      model={tunes[block.agent.name]?.model ?? ""}
                      effort={tunes[block.agent.name]?.effort ?? ""}
                      inherit={
                        model
                          ? softwareFamily(software) !== "cursor" && effort
                            ? `${model} · ${effort}`
                            : model
                          : "default"
                      }
                      onChange={(next) => setTune(block.agent.name, next)}
                    />
                    {block.ok ? <pre className="launch-pre">{block.text}</pre> : <p className="help-p">{block.error}</p>}
                  </article>
                ))}
              </>
            )
          ) : built.ok ? (
            <section className="launch-preview" aria-label="Command preview">
              <header>
                <span>Command preview</span>
                <button type="button" disabled={!canCopyOne} onClick={() => void onCopy(built.text, "one")}>
                  <Copy size={13} aria-hidden="true" />
                  {copied === "one" ? "Copied" : "Copy"}
                </button>
              </header>
              <pre className="launch-pre">{built.text}</pre>
            </section>
          ) : (
            <p className="help-p">{built.error}</p>
          )}
          {native && terminalBlock && <TerminalNotice blocker={terminalBlock} compact />}
          {native && launchNote && (
            <p className={launchNote.error ? "err launch-note" : "help-p launch-note"} role={launchNote.error ? "alert" : "status"}>{launchNote.text}</p>
          )}
        </div>
        <div className="row sheet-footer launch-footer">
          <label className="check">
            <input
              type="checkbox"
              checked={resume}
              onChange={(e) => {
                setResume(e.target.checked);
                remember({ resume: e.target.checked });
              }}
            />
            Resume same employees
          </label>
          {resume && (
            <label className="check">
              <input
                type="checkbox"
                checked={allHives}
                onChange={(e) => {
                  setAllHives(e.target.checked);
                  remember({ allHives: e.target.checked });
                }}
              />
              all hives
            </label>
          )}
          <button type="button" className="launch-close" onClick={onClose}>
            Close
          </button>
          {resume ? (
            <button
              type="button"
              className={native ? "btn" : "primary"}
              disabled={!canCopyAll}
              onClick={() => void onCopy(allText, "all")}
            >
              <Copy size={14} aria-hidden="true" />
              {copied === "all" ? "Copied" : "Copy all"}
            </button>
          ) : (
            <button
              type="button"
              className={native ? "btn" : "primary"}
              disabled={!canCopyOne}
              onClick={() => void onCopy(built.ok ? built.text : "", "one")}
            >
              <Copy size={14} aria-hidden="true" />
              {copied === "one" ? "Copied" : "Copy command"}
            </button>
          )}
          {native && (
            <button
              type="button"
              className={terminalApp ? "btn launch-background" : "primary launch-background"}
              disabled={!canLaunchTerminal}
              title={terminalProblem ?? (terminalApp
                ? "Start in tmux without a window; open it later from Terminal sessions or the agent’s Terminal tab"
                : "Start in tmux on your Mac and open its terminal here")}
              onClick={() => onLaunchTerminal(false)}
            >
              <Play size={14} aria-hidden="true" />
              {backgroundLabel}
            </button>
          )}
          {terminalApp && (
            <button
              type="button"
              className="primary launch-terminal"
              disabled={!canLaunchTerminal}
              title={terminalProblem ?? undefined}
              onClick={() => onLaunchTerminal(true)}
            >
              <SquareTerminal size={14} aria-hidden="true" />
              {launching ? "Launching…" : terminalLabel}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
