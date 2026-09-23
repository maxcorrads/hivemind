import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { childEnv } from "../test-support/child-process.ts";

test("MCP initialize and tools/list expose the hive", { timeout: 20000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const client = new Client({ name: "hivemind-test", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(root, "src/cli.ts"), "mcp"],
    cwd: root,
    stderr: "inherit",
    // The SDK default (a sudo-like whitelist), minus the coverage directory.
    env: childEnv(getDefaultEnvironment()),
  });
  t.after(() => client.close());
  await client.connect(transport, { timeout: 8000, signal: t.signal });
  // A tools/list reply can span many stdout chunks. In particular, a partial
  // description can contain "wait" before the actual wait tool arrives. Let
  // the protocol transport frame and validate the complete response instead
  // of treating substring matches in a partial JSON message as completion.
  const { tools } = await client.listTools({}, { timeout: 8000, signal: t.signal });
  const names = new Set(tools.map(tool => tool.name));
  for (const name of ["join", "wait", "send", "search", "get_task", "assign_task", "task_event", "get_room", "room_event"]) {
    assert.ok(names.has(name), `Missing MCP tool: ${name}`);
  }
});
