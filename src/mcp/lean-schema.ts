import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Keywords whose value maps names to schemas: their keys are field names, never keywords. */
const NAME_MAPS = new Set(["properties", "patternProperties", "definitions", "$defs"]);
/** Keywords whose value is data, not a schema. */
const DATA = new Set(["enum", "const", "default", "examples"]);

/**
 * A JSON Schema without two keywords that tell a model nothing it needs to form a call (docs/agent-connection.md,
 * "Size of the tool list"): `$schema`, the dialect, and a `pattern` next to a `format`, since zod spells the regex of
 * every UUID out beside `format: "uuid"`. Everything else stays, `additionalProperties` and a `pattern` on its own
 * included. The input is not changed. Validation is not affected: the server's zod schemas check every call.
 */
export function leanSchema(node: unknown, nameMap = false): unknown {
  if (Array.isArray(node)) return node.map(item => leanSchema(item));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (nameMap) { out[key] = leanSchema(value); continue; }
    if (key === "$schema" || (key === "pattern" && "format" in node)) continue;
    out[key] = DATA.has(key) ? value : leanSchema(value, NAME_MAPS.has(key));
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A `tools/list` result with every tool's input schema made lean; any other message as it is. The answer is known by
 * its shape, a `result.tools` list of named tools, which no other MCP result has.
 */
export function leanToolList(message: JSONRPCMessage): JSONRPCMessage {
  if (!("result" in message)) return message;
  const result: unknown = message.result;
  if (!isRecord(result)) return message;
  const tools: unknown = result.tools;
  if (!Array.isArray(tools)) return message;
  const listed: unknown[] = tools;
  const named = listed.filter((tool): tool is Record<string, unknown> =>
    isRecord(tool) && typeof tool.name === "string" && isRecord(tool.inputSchema));
  if (named.length !== listed.length) return message;
  const lean = named.map(tool => ({ ...tool, inputSchema: leanSchema(tool.inputSchema) }));
  return { ...message, result: { ...result, tools: lean } } as JSONRPCMessage;
}
