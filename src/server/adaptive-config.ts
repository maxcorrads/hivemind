import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { HiveError } from "../shared/types.ts";
import { JEV_MODEL_ALIAS, validJevModel } from "../shared/jev-model.ts";

export const ADAPTIVE_ROUTING_CONFIG_VERSION = 1;
export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Requested when no model is pinned; see src/shared/jev-model.ts. */
export const TYPESAFE_MODEL = JEV_MODEL_ALIAS;
export { validJevModel };

/**
 * Jev settings. Since #211 Jev only advises brains, so the former `fallback` and `topologyFallback` (the mode applied
 * when Jev was uncertain) have no meaning: they are ignored when read from an old file and dropped on the next save,
 * and rejected as unknown settings when sent (#214).
 */
export type AdaptiveRoutingFile = {
  version: 1;
  enabled: boolean;
  apiKey: string;
  /** Requested Jev model identifier. Configs saved before #134 omit it and use TYPESAFE_MODEL. */
  model: string;
};

export type AdaptiveRoutingPublic = {
  enabled: boolean;
  apiKeySet: boolean;
  apiKeyHint: string | null;
  /** The identifier Hivemind requests from TypeSafe. */
  model: string;
  /** The provider alias used when nothing is pinned. */
  defaultModel: string;
  /** True when the Human pinned an identifier other than the default alias. */
  modelPinned: boolean;
};

export type AdaptiveRoutingInput = {
  enabled?: boolean;
  apiKey?: string | null;
  /** A bounded identifier, or null/empty to return to the default alias. */
  model?: string | null;
};

function configPath(home: string): string {
  return path.join(home, "adaptive-routing.json");
}

function maskKey(value: string): string {
  const key = value.trim();
  if (key.length < 8) return "set";
  return `…${key.slice(-4)}`;
}

function readRawConfig(home: string): AdaptiveRoutingFile | null {
  const file = configPath(home);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AdaptiveRoutingFile>;
    const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
    if (raw.version !== ADAPTIVE_ROUTING_CONFIG_VERSION || typeof raw.enabled !== "boolean") return null;
    if (raw.enabled && !apiKey) return null;
    // An invalid identifier fails closed like any other invalid setting: the file is ignored, Jev stays off.
    if (raw.model !== undefined && !validJevModel(raw.model)) return null;
    return {
      version: 1,
      enabled: raw.enabled,
      apiKey,
      model: raw.model ?? TYPESAFE_MODEL,
    };
  } catch {
    return null;
  }
}

function persistConfig(home: string, config: AdaptiveRoutingFile): void {
  // The default alias is not written, so an unpinned file stays identical to the pre-#134 format.
  const { model, ...rest } = config;
  const value = model === TYPESAFE_MODEL ? rest : config;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = path.join(home, `.adaptive-routing-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, configPath(home));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export function adaptiveRoutingPublic(home: string): AdaptiveRoutingPublic {
  const config = readRawConfig(home);
  return {
    enabled: config?.enabled ?? false,
    apiKeySet: Boolean(config?.apiKey),
    apiKeyHint: config?.apiKey ? maskKey(config.apiKey) : null,
    model: config?.model ?? TYPESAFE_MODEL,
    defaultModel: TYPESAFE_MODEL,
    modelPinned: Boolean(config && config.model !== TYPESAFE_MODEL),
  };
}

export function saveAdaptiveRouting(home: string, raw: unknown): AdaptiveRoutingPublic {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new HiveError(400, "Adaptive routing settings must be an object");
  const input = raw as AdaptiveRoutingInput & Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => key !== "enabled" && key !== "apiKey" && key !== "model");
  if (unknown.length) throw new HiveError(400, "Unknown adaptive routing setting");
  const previous = readRawConfig(home);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw new HiveError(400, "Adaptive routing enabled must be boolean");
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== "string")
    throw new HiveError(400, "Invalid TypeSafe API key");
  if (input.model !== undefined && input.model !== null && typeof input.model !== "string")
    throw new HiveError(400, "Jev model must be an identifier");
  const requestedModel = typeof input.model === "string" ? input.model.trim() : input.model;
  if (requestedModel && !validJevModel(requestedModel))
    throw new HiveError(400, "Jev model must be a bounded identifier (letters, digits, dot, underscore, hyphen; no URL)");
  const enabled = input.enabled ?? previous?.enabled ?? false;
  const apiKey = input.apiKey === null ? "" : input.apiKey?.trim() || previous?.apiKey || "";
  const model = requestedModel === undefined ? previous?.model ?? TYPESAFE_MODEL : requestedModel || TYPESAFE_MODEL;
  if (apiKey.length > 512) throw new HiveError(400, "TypeSafe API key is too long");
  if (enabled && !apiKey) throw new HiveError(400, "TypeSafe API key is required when Jev adaptive routing is enabled");
  try {
    persistConfig(home, { version: 1, enabled, apiKey, model });
  } finally {
    cached.delete(home);
  }
  return adaptiveRoutingPublic(home);
}

/** Reads the settings file (settings page, diagnostics). The runtime uses {@link cachedAdaptiveRouting}. */
export function loadAdaptiveRouting(home: string): AdaptiveRoutingFile | null {
  return readRawConfig(home);
}

const cached = new Map<string, AdaptiveRoutingFile | null>();
/**
 * The settings as the runtime sees them, read once per hive home and re-read after every save through
 * {@link saveAdaptiveRouting} (#214): brain actions and Human sends never read the file. A hand edit of the file takes
 * effect after a restart or the next save.
 */
export function cachedAdaptiveRouting(home: string): AdaptiveRoutingFile | null {
  if (!cached.has(home)) cached.set(home, readRawConfig(home));
  return cached.get(home) ?? null;
}
