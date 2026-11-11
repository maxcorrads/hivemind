import assert from "node:assert/strict";
import { test } from "node:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { leanSchema, leanToolList } from "./lean-schema.ts";

const DIALECT = "http://json-schema.org/draft-07/schema#";
const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const uuid = { type: "string", format: "uuid", pattern: UUID };

test("a lean schema drops the dialect and a pattern next to a format, and keeps everything else", () => {
  const schema = {
    $schema: DIALECT, type: "object", additionalProperties: false, required: ["taskId", "action"],
    properties: {
      taskId: uuid,
      requestId: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9._-]+$" },
      ids: { type: "array", maxItems: 12, items: uuid },
      action: { anyOf: [
        { type: "object", additionalProperties: false, required: ["type"], properties: { type: { type: "string", const: "accept" } } },
        { type: "object", additionalProperties: false, required: ["type", "taskId"],
          properties: { type: { type: "string", const: "stopped" }, taskId: { ...uuid, description: "The task" } } },
      ] },
    },
  };
  const before = structuredClone(schema);
  assert.deepEqual(leanSchema(schema), {
    type: "object", additionalProperties: false, required: ["taskId", "action"],
    properties: {
      taskId: { type: "string", format: "uuid" },
      requestId: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9._-]+$" },
      ids: { type: "array", maxItems: 12, items: { type: "string", format: "uuid" } },
      action: { anyOf: [
        { type: "object", additionalProperties: false, required: ["type"], properties: { type: { type: "string", const: "accept" } } },
        { type: "object", additionalProperties: false, required: ["type", "taskId"],
          properties: { type: { type: "string", const: "stopped" }, taskId: { type: "string", format: "uuid", description: "The task" } } },
      ] },
    },
  });
  assert.deepEqual(schema, before, "the input is not changed");
});

test("fields named like a keyword stay, and data is never read as a schema", () => {
  const schema = {
    type: "object",
    properties: {
      // Field names, not keywords: a tool may take a `pattern`, a `format` or a `$schema` argument.
      pattern: { type: "string" }, format: { type: "string" }, $schema: { type: "string" },
      nested: { type: "object", properties: { pattern: uuid, format: { type: "string", enum: ["a", "b"] } } },
      choice: { enum: [{ format: "uuid", pattern: UUID }], default: { format: "uuid", pattern: UUID }, const: { $schema: DIALECT } },
    },
  };
  assert.deepEqual(leanSchema(schema), {
    type: "object",
    properties: {
      pattern: { type: "string" }, format: { type: "string" }, $schema: { type: "string" },
      nested: { type: "object", properties: { pattern: { type: "string", format: "uuid" }, format: { type: "string", enum: ["a", "b"] } } },
      choice: { enum: [{ format: "uuid", pattern: UUID }], default: { format: "uuid", pattern: UUID }, const: { $schema: DIALECT } },
    },
  });
  for (const value of [null, undefined, true, 7, "text"]) assert.equal(leanSchema(value), value);
  assert.deepEqual(leanSchema([uuid, 1]), [{ type: "string", format: "uuid" }, 1]);
});

test("only a tools/list result is made lean; every other message passes as it is", () => {
  const tool = { name: "get_task", description: "Read a task.",
    inputSchema: { $schema: DIALECT, type: "object", properties: { taskId: uuid }, required: ["taskId"], additionalProperties: false } };
  const list = { jsonrpc: "2.0", id: 2, result: { tools: [tool, { name: "agents", inputSchema: { type: "object", properties: {} } }], nextCursor: "next" } } as JSONRPCMessage;
  assert.deepEqual(leanToolList(list), { jsonrpc: "2.0", id: 2, result: { nextCursor: "next", tools: [
    { name: "get_task", description: "Read a task.",
      inputSchema: { type: "object", properties: { taskId: { type: "string", format: "uuid" } }, required: ["taskId"], additionalProperties: false } },
    { name: "agents", inputSchema: { type: "object", properties: {} } },
  ] } });
  assert.equal(tool.inputSchema.$schema, DIALECT, "the message is not changed");

  const others = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
    { jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Tool x not found" } },
    { jsonrpc: "2.0", id: 4, result: {} },
    { jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: JSON.stringify({ tools: [tool] }) }] } },
    // Not a list of tools: a result that only happens to carry a `tools` key.
    { jsonrpc: "2.0", id: 6, result: { tools: "none" } },
    { jsonrpc: "2.0", id: 7, result: { tools: [{ name: "x" }, tool] } },
  ] as JSONRPCMessage[];
  for (const message of others) assert.equal(leanToolList(message), message, JSON.stringify(message));
});
