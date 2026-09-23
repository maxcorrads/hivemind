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
import type { AdaptiveTopology } from "../shared/adaptive-topology.ts";

export const ADAPTIVE_ROUTING_CONFIG_VERSION = 1;
export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODEL = "jev-latest";

export type AdaptiveStrategy = "single" | "orchestrated";

export type AdaptiveRoutingFile = {
  version: 1;
  enabled: boolean;
  apiKey: string;
  fallback: AdaptiveStrategy;
  topologyFallback: Exclude<AdaptiveTopology, "single">;
};

export type AdaptiveRoutingPublic = {
  enabled: boolean;
  apiKeySet: boolean;
  apiKeyHint: string | null;
  model: string;
  fallback: AdaptiveStrategy;
  topologyFallback: Exclude<AdaptiveTopology, "single">;
};

export type AdaptiveRoutingInput = {
  enabled?: boolean;
  apiKey?: string | null;
  fallback?: AdaptiveStrategy;
  topologyFallback?: Exclude<AdaptiveTopology, "single">;
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
    if (raw.fallback !== undefined && raw.fallback !== "single" && raw.fallback !== "orchestrated") return null;
    if (raw.topologyFallback !== undefined && !["brain_one_worker", "brain_multi_dm", "brain_multi_room"].includes(raw.topologyFallback)) return null;
    if (raw.enabled && !apiKey) return null;
    return {
      version: 1,
      enabled: raw.enabled,
      apiKey,
      fallback: raw.fallback ?? "orchestrated",
      topologyFallback: raw.topologyFallback ?? "brain_one_worker",
    };
  } catch {
    return null;
  }
}

function persistConfig(home: string, value: AdaptiveRoutingFile): void {
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
    model: TYPESAFE_MODEL,
    fallback: config?.fallback ?? "orchestrated",
    topologyFallback: config?.topologyFallback ?? "brain_one_worker",
  };
}

export function saveAdaptiveRouting(home: string, raw: unknown): AdaptiveRoutingPublic {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new HiveError(400, "Adaptive routing settings must be an object");
  const input = raw as AdaptiveRoutingInput & Record<string, unknown>;
  const unknown = Object.keys(input).filter(key =>
    key !== "enabled" && key !== "apiKey" && key !== "fallback" && key !== "topologyFallback");
  if (unknown.length) throw new HiveError(400, "Unknown adaptive routing setting");
  const previous = readRawConfig(home);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw new HiveError(400, "Adaptive routing enabled must be boolean");
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== "string")
    throw new HiveError(400, "Invalid TypeSafe API key");
  if (input.fallback !== undefined && input.fallback !== "single" && input.fallback !== "orchestrated")
    throw new HiveError(400, "Adaptive routing fallback must be single or orchestrated");
  if (input.topologyFallback !== undefined &&
      !["brain_one_worker", "brain_multi_dm", "brain_multi_room"].includes(input.topologyFallback))
    throw new HiveError(400, "Adaptive topology fallback must be Brain+1, Multi-DM or Room");
  const enabled = input.enabled ?? previous?.enabled ?? false;
  const apiKey = input.apiKey === null ? "" : input.apiKey?.trim() || previous?.apiKey || "";
  const fallback = input.fallback ?? previous?.fallback ?? "orchestrated";
  const topologyFallback = input.topologyFallback ?? previous?.topologyFallback ?? "brain_one_worker";
  if (apiKey.length > 512) throw new HiveError(400, "TypeSafe API key is too long");
  if (enabled && !apiKey) throw new HiveError(400, "TypeSafe API key is required when Jev adaptive routing is enabled");
  persistConfig(home, { version: 1, enabled, apiKey, fallback, topologyFallback });
  return adaptiveRoutingPublic(home);
}

export function loadAdaptiveRouting(home: string): AdaptiveRoutingFile | null {
  return readRawConfig(home);
}
