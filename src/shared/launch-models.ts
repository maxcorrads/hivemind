import { softwareFamily } from "./launch-prompt.ts";

export type ModelGroup = { label: string; models: string[] };

const CODEX = [
  "gpt-6-astra",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-daybreak-blue-latest",
  "o3",
  "o4-mini",
];

const CLAUDE = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
];

const CURSOR = [
  "auto",
  "composer-2.5",
  "composer-2.5-fast",
  "gpt-5.3-codex",
  "gpt-5.3-codex-fast",
  "gpt-5.3-codex-high",
  "gpt-5.3-codex-high-fast",
  "gpt-5.3-codex-low",
  "gpt-5.3-codex-low-fast",
  "gpt-5.3-codex-xhigh",
  "gpt-5.3-codex-xhigh-fast",
  "gpt-5.2",
  "gpt-5.2-fast",
  "gpt-5.2-high",
  "gpt-5.2-high-fast",
  "gpt-5.2-low",
  "gpt-5.2-low-fast",
  "gpt-5.2-xhigh",
  "gpt-5.2-xhigh-fast",
  "gpt-5.1",
  "gpt-5.1-high",
  "gpt-5.1-low",
  "gpt-5-mini",
  "gpt-5.4-high",
  "gpt-5.4-high-fast",
  "gpt-5.4-medium",
  "gpt-5.4-medium-fast",
  "gpt-5.4-low",
  "gpt-5.4-xhigh",
  "gpt-5.4-xhigh-fast",
  "gpt-5.4-mini-none",
  "gpt-5.4-mini-low",
  "gpt-5.4-mini-medium",
  "gpt-5.4-mini-high",
  "gpt-5.4-mini-xhigh",
  "gpt-5.4-nano-none",
  "gpt-5.4-nano-low",
  "gpt-5.4-nano-medium",
  "gpt-5.4-nano-high",
  "gpt-5.4-nano-xhigh",
  "gpt-5.5-none",
  "gpt-5.5-none-fast",
  "gpt-5.5-low",
  "gpt-5.5-low-fast",
  "gpt-5.5-medium",
  "gpt-5.5-medium-fast",
  "gpt-5.5-high",
  "gpt-5.5-high-fast",
  "gpt-5.5-extra-high",
  "gpt-5.5-extra-high-fast",
  "gpt-5.6-luna-none",
  "gpt-5.6-luna-none-fast",
  "gpt-5.6-luna-low",
  "gpt-5.6-luna-low-fast",
  "gpt-5.6-luna-medium",
  "gpt-5.6-luna-medium-fast",
  "gpt-5.6-luna-high",
  "gpt-5.6-luna-high-fast",
  "gpt-5.6-luna-xhigh",
  "gpt-5.6-luna-xhigh-fast",
  "gpt-5.6-luna-max",
  "gpt-5.6-luna-max-fast",
  "gpt-5.6-sol-none",
  "gpt-5.6-sol-none-fast",
  "gpt-5.6-sol-low",
  "gpt-5.6-sol-low-fast",
  "gpt-5.6-sol-medium",
  "gpt-5.6-sol-medium-fast",
  "gpt-5.6-sol-high",
  "gpt-5.6-sol-high-fast",
  "gpt-5.6-sol-xhigh",
  "gpt-5.6-sol-xhigh-fast",
  "gpt-5.6-sol-max",
  "gpt-5.6-sol-max-fast",
  "gpt-5.6-terra-none",
  "gpt-5.6-terra-none-fast",
  "gpt-5.6-terra-low",
  "gpt-5.6-terra-low-fast",
  "gpt-5.6-terra-medium",
  "gpt-5.6-terra-medium-fast",
  "gpt-5.6-terra-high",
  "gpt-5.6-terra-high-fast",
  "gpt-5.6-terra-xhigh",
  "gpt-5.6-terra-xhigh-fast",
  "gpt-5.6-terra-max",
  "gpt-5.6-terra-max-fast",
  "claude-opus-5-low",
  "claude-opus-5-low-fast",
  "claude-opus-5-medium",
  "claude-opus-5-medium-fast",
  "claude-opus-5-high",
  "claude-opus-5-high-fast",
  "claude-opus-5-thinking-low",
  "claude-opus-5-thinking-low-fast",
  "claude-opus-5-thinking-medium",
  "claude-opus-5-thinking-medium-fast",
  "claude-opus-5-thinking-high",
  "claude-opus-5-thinking-high-fast",
  "claude-opus-5-thinking-xhigh",
  "claude-opus-5-thinking-xhigh-fast",
  "claude-opus-5-thinking-max",
  "claude-opus-5-thinking-max-fast",
  "claude-opus-4-8-low",
  "claude-opus-4-8-low-fast",
  "claude-opus-4-8-medium",
  "claude-opus-4-8-medium-fast",
  "claude-opus-4-8-high",
  "claude-opus-4-8-high-fast",
  "claude-opus-4-8-xhigh",
  "claude-opus-4-8-xhigh-fast",
  "claude-opus-4-8-max",
  "claude-opus-4-8-max-fast",
  "claude-opus-4-8-thinking-low",
  "claude-opus-4-8-thinking-low-fast",
  "claude-opus-4-8-thinking-medium",
  "claude-opus-4-8-thinking-medium-fast",
  "claude-opus-4-8-thinking-high",
  "claude-opus-4-8-thinking-high-fast",
  "claude-opus-4-8-thinking-xhigh",
  "claude-opus-4-8-thinking-xhigh-fast",
  "claude-opus-4-8-thinking-max",
  "claude-opus-4-8-thinking-max-fast",
  "claude-opus-4-7-low",
  "claude-opus-4-7-low-fast",
  "claude-opus-4-7-medium",
  "claude-opus-4-7-medium-fast",
  "claude-opus-4-7-high",
  "claude-opus-4-7-high-fast",
  "claude-opus-4-7-xhigh",
  "claude-opus-4-7-xhigh-fast",
  "claude-opus-4-7-max",
  "claude-opus-4-7-max-fast",
  "claude-opus-4-7-thinking-low",
  "claude-opus-4-7-thinking-low-fast",
  "claude-opus-4-7-thinking-medium",
  "claude-opus-4-7-thinking-medium-fast",
  "claude-opus-4-7-thinking-high",
  "claude-opus-4-7-thinking-high-fast",
  "claude-opus-4-7-thinking-xhigh",
  "claude-opus-4-7-thinking-xhigh-fast",
  "claude-opus-4-7-thinking-max",
  "claude-opus-4-7-thinking-max-fast",
  "claude-sonnet-5-low",
  "claude-sonnet-5-medium",
  "claude-sonnet-5-high",
  "claude-sonnet-5-xhigh",
  "claude-sonnet-5-max",
  "claude-sonnet-5-thinking-low",
  "claude-sonnet-5-thinking-medium",
  "claude-sonnet-5-thinking-high",
  "claude-sonnet-5-thinking-xhigh",
  "claude-sonnet-5-thinking-max",
  "claude-fable-5-low",
  "claude-fable-5-medium",
  "claude-fable-5-high",
  "claude-fable-5-xhigh",
  "claude-fable-5-max",
  "claude-fable-5-thinking-low",
  "claude-fable-5-thinking-medium",
  "claude-fable-5-thinking-high",
  "claude-fable-5-thinking-xhigh",
  "claude-fable-5-thinking-max",
  "claude-fable-5-1-low",
  "claude-fable-5-1-medium",
  "claude-fable-5-1-high",
  "claude-fable-5-1-xhigh",
  "claude-fable-5-1-max",
  "claude-fable-5-1-thinking-low",
  "claude-fable-5-1-thinking-medium",
  "claude-fable-5-1-thinking-high",
  "claude-fable-5-1-thinking-xhigh",
  "claude-fable-5-1-thinking-max",
  "claude-4.6-opus-high",
  "claude-4.6-opus-high-thinking",
  "claude-4.6-opus-max",
  "claude-4.6-opus-max-thinking",
  "claude-4.6-sonnet-medium",
  "claude-4.6-sonnet-medium-thinking",
  "claude-4.5-opus-high",
  "claude-4.5-opus-high-thinking",
  "claude-4.5-sonnet",
  "claude-4.5-sonnet-thinking",
  "claude-4-sonnet",
  "claude-4-sonnet-thinking",
  "grok-4.7-low",
  "grok-4.7-low-fast",
  "grok-4.7-medium",
  "grok-4.7-medium-fast",
  "grok-4.7-high",
  "grok-4.7-high-fast",
  "grok-4.7-xhigh",
  "grok-4.7-xhigh-fast",
  "cursor-grok-4.6-low",
  "cursor-grok-4.6-low-fast",
  "cursor-grok-4.6-medium",
  "cursor-grok-4.6-medium-fast",
  "cursor-grok-4.6-high",
  "cursor-grok-4.6-high-fast",
  "cursor-grok-4.6-xhigh",
  "cursor-grok-4.6-xhigh-fast",
  "cursor-grok-4.5-low",
  "cursor-grok-4.5-low-fast",
  "cursor-grok-4.5-medium",
  "cursor-grok-4.5-medium-fast",
  "cursor-grok-4.5-high",
  "cursor-grok-4.5-high-fast",
  "gemini-3.8-flash-low",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-high",
  "gemini-3.7-flash-low",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-high",
  "gemini-3.6-flash-minimal",
  "gemini-3.6-flash-low",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-high",
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3-flash",
  "muse-spark-1.3-minimal",
  "muse-spark-1.3-low",
  "muse-spark-1.3-medium",
  "muse-spark-1.3-high",
  "muse-spark-1.3-xhigh",
  "muse-spark-1.3-max",
  "kimi-k2.7-code",
  "kimi-k3-low",
  "kimi-k3-high",
  "kimi-k3-max",
  "glm-5.2-high",
  "glm-5.2-max",
];

const OPENCODE = [
  "opencode-go/muse-spark-1.3-contributor",
  "opencode/muse-spark-1.3-contributor-free",
  "opencode-go/muse-spark-1.2-contributor",
  "opencode/muse-spark-1.2-contributor-free",
];

const PICK_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type ModelChoice = {
  id: string;
  label: string;
  model: string;
  effort: string;
};

export type ModelChoiceGroup = { label: string; choices: ModelChoice[] };

function unique(models: string[]): string[] {
  return [...new Set(models)];
}

type Family = "codex" | "claude" | "cursor" | "opencode";

export function modelChoiceId(family: Family | "other", model: string, effort: string): string {
  const slug = model.trim();
  const level = effort.trim();
  if (!slug) return "";
  return level ? `${family}:${slug}::${level}` : `${family}:${slug}`;
}

function withEfforts(family: Family, models: string[]): ModelChoice[] {
  const choices: ModelChoice[] = [];
  for (const model of unique(models)) {
    choices.push({ id: modelChoiceId(family, model, ""), label: model, model, effort: "" });
    for (const effort of PICK_EFFORTS) {
      choices.push({
        id: modelChoiceId(family, model, effort),
        label: `${model} · ${effort}`,
        model,
        effort,
      });
    }
  }
  return choices;
}

function slugsOnly(family: Family, models: string[]): ModelChoice[] {
  return unique(models).map((model) => ({
    id: modelChoiceId(family, model, ""),
    label: model,
    model,
    effort: "",
  }));
}

export function modelChoiceGroups(software: string): ModelChoiceGroup[] {
  const family = softwareFamily(software);
  const all: ModelChoiceGroup[] = [
    { label: "Codex", choices: withEfforts("codex", CODEX) },
    { label: "Claude", choices: withEfforts("claude", CLAUDE) },
    { label: "Cursor", choices: slugsOnly("cursor", CURSOR) },
    { label: "OpenCode", choices: withEfforts("opencode", OPENCODE) },
  ];
  if (family === "codex") return all.filter((g) => g.label === "Codex");
  if (family === "claude") return all.filter((g) => g.label === "Claude");
  if (family === "cursor") return all.filter((g) => g.label === "Cursor");
  if (family === "opencode") return all.filter((g) => g.label === "OpenCode");
  return all;
}

export function selectedChoiceId(software: string, model: string, effort: string): string {
  const groups = modelChoiceGroups(software);
  const m = model.trim();
  const e = softwareFamily(software) === "cursor" ? "" : effort.trim();
  const hit = groups.flatMap((g) => g.choices).find((c) => c.model === m && c.effort === e);
  if (hit) return hit.id;
  return modelChoiceId("other", m, e);
}

export function parseChoiceId(id: string): { model: string; effort: string } {
  const trimmed = id.trim();
  if (!trimmed) return { model: "", effort: "" };
  const prefixed = /^(codex|claude|cursor|opencode|other):(.+)$/.exec(trimmed);
  const rest = prefixed ? prefixed[2] : trimmed;
  const sep = rest.indexOf("::");
  if (sep === -1) return { model: rest, effort: "" };
  return { model: rest.slice(0, sep), effort: rest.slice(sep + 2) };
}

/** @deprecated use modelChoiceGroups — kept for tests that check base slugs */
export function modelGroups(software: string): ModelGroup[] {
  return modelChoiceGroups(software).map((group) => ({
    label: group.label,
    models: unique(group.choices.map((c) => c.model)),
  }));
}

export function allLaunchModels(): string[] {
  return unique([...CODEX, ...CLAUDE, ...CURSOR, ...OPENCODE]);
}
