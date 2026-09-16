import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, Project, Seniority } from "../src/shared/types.ts";
import { modelChoiceGroups, parseChoiceId, selectedChoiceId } from "../src/shared/launch-models.ts";
import { api } from "./api.ts";
import { projectLaunchTools, type LaunchContext } from "../src/shared/launch-prompt.ts";
import {
  EFFORTS,
  buildLaunchBlock,
  buildRosterPaste,
  codexSessionTitle,
  effectiveSoftware,
  resolveLaunchTune,
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.target instanceof HTMLSelectElement) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, [onClose]);

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
      return {
        ok: true as const,
        text: buildLaunchBlock({
          ...shared,
          ...projectLaunchTools(launchContext, project ?? projects.find((p) => p.slug === projectSlug), role),
          workspacePath,
          projectSlug: project?.slug ?? projectSlug,
          hiveName,
          role,
          seniority: role === "worker" ? seniority : null,
          focus,
          resume: false,
        }),
      };
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
        return {
          agent,
          hive,
          ok: true as const,
          text: buildLaunchBlock({
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
          }),
        };
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

  const allText = buildRosterPaste(
    resumeBlocks
      .filter((b) => b.ok)
      .map((b) => ({
        title: codexSessionTitle(b.hive?.name ?? "", b.agent.name) || b.agent.name,
        text: b.text,
      })),
  );

  const canCopyOne = built.ok && projects.length > 0;
  const canCopyAll = resume && resumeBlocks.length > 0 && resumeBlocks.every((b) => b.ok);

  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet sheet-wide" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-body">
          <h2>Launch agent</h2>
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
          <label>
            Software
            <input
              list="launch-software"
              value={software}
              onChange={(e) => setSoftware(e.target.value)}
              onBlur={() => remember()}
              placeholder="codex"
              autoComplete="off"
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
          <label>
            CLI flags
            <input
              value={extraFlags}
              onChange={(e) => setExtraFlags(e.target.value)}
              onBlur={() => remember()}
              placeholder="optional"
              autoComplete="off"
            />
          </label>
          <label>
            Hive
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
          <label>
            Workspace path
            <input
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
          {!resume && (
            <>
              <label>
                Role
                <select
                  value={role}
                  onChange={(e) => {
                    const next = e.target.value as LaunchRole;
                    const nextFocus =
                      next === "brain" && focus === "frontend"
                        ? "coord"
                        : next === "worker" && focus === "coord"
                          ? "frontend"
                          : focus;
                    setRole(next);
                    if (nextFocus !== focus) setFocus(nextFocus);
                    remember({ role: next, focus: nextFocus });
                  }}
                >
                  <option value="brain">brain</option>
                  <option value="worker">worker</option>
                </select>
              </label>
              {role === "worker" && (
                <label>
                  Seniority
                  <select
                    value={seniority}
                    onChange={(e) => {
                      const next = e.target.value as Seniority;
                      setSeniority(next);
                      remember({ seniority: next });
                    }}
                  >
                    <option value="senior">senior</option>
                    <option value="mid">mid</option>
                    <option value="junior">junior</option>
                  </select>
                </label>
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
          <fieldset className="checks">
            <legend>Resume</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={resume}
                onChange={(e) => {
                  setResume(e.target.checked);
                  remember({ resume: e.target.checked });
                }}
              />
              same employees — show every brain and worker
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
          </fieldset>
          {adoptUntrusted && (
            <p className="help-p">
              The first lines tell this CLI session it may trust Human and brain mail from Hivemind. They are in the block only if you mean that.
            </p>
          )}
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
                        className="text-btn"
                        disabled={!block.ok}
                        onClick={() => void onCopy(block.text, block.agent.id)}
                      >
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
            <pre className="launch-pre">{built.text}</pre>
          ) : (
            <p className="help-p">{built.error}</p>
          )}
        </div>
        <div className="row">
          <button type="button" onClick={onClose}>
            Close
          </button>
          {resume ? (
            <button
              type="button"
              className="primary"
              disabled={!canCopyAll}
              onClick={() => void onCopy(allText, "all")}
            >
              {copied === "all" ? "Copied" : "Copy all"}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={!canCopyOne}
              onClick={() => void onCopy(built.ok ? built.text : "", "one")}
            >
              {copied === "one" ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
