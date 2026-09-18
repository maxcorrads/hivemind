import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Hive } from "../server/hive.ts";
import { startServer } from "../server/serve.ts";

function textResult(result: CallToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const content = result.content[0];
  assert.ok(content && content.type === "text");
  return JSON.parse(content.text) as Record<string, unknown>;
}

test("production MCP schemas and calls retain their observable contracts", { timeout: 45_000 }, async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-schema-"));
  let hive: Hive | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let client: Client | undefined;
  t.after(async () => {
    try {
      await client?.close();
    } finally {
      try {
        if (server) {
          const closed = once(server.server, "close");
          server.shutdown();
          server.server.closeAllConnections();
          await closed;
        }
      } finally {
        hive?.db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  const database = new Hive(path.join(dir, "hive.db"));
  hive = database;
  server = startServer({ hive: database, port: 0, telegram: false });
  const port = await server.ready;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(root, "src/cli.ts"), "mcp"],
    cwd: root,
    env: { HIVEMIND_HOME: path.join(dir, "client"), HIVEMIND_URL: `http://127.0.0.1:${port}`, HIVEMIND_TOKEN: "" },
    stderr: "pipe",
  });
  let diagnostic = "";
  transport.stderr?.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + String(chunk)).slice(-4000); });
  const connected = new Client({ name: "hivemind-schema-test", version: "0" });
  client = connected;
  try {
    await connected.connect(transport, { timeout: 10_000, signal: t.signal });
  } catch (error) {
    throw new Error(`MCP startup failed: ${diagnostic}`, { cause: error });
  }
  const call = (name: string, args: Record<string, unknown> = {}) => connected.callTool(
    { name, arguments: args }, CallToolResultSchema, { timeout: 5000, signal: t.signal },
  );

  await t.test("all advertised production inputs retain types, required fields and enums", async () => {
    const { tools } = await connected.listTools({}, { timeout: 5000, signal: t.signal });
    const expected: Record<string, [string[], Record<string, string>]> = {
      join: [["role"], { role: "string", seniority: "string", focus: "string", resume: "string", project: "string" }],
      whoami: [[], {}], standing_orders: [[], {}], agents: [[], {}], wait: [[], {}],
      channels: [[], { unread: "boolean" }],
      search: [["q"], { q: "string", channel: "string", limit: "number", before: "number" }],
      history: [["channel"], { channel: "string", threadId: "string", limit: "number", since: "number", meta: "boolean" }],
      send: [["body"], { body: "string", channel: "string", to: "string", threadId: "string", attachmentIds: "array" }],
      create_channel: [["name"], { name: "string", type: "string", topic: "string", members: "array" }],
      set_thread_status: [["threadId", "status"], { threadId: "string", status: "string" }],
      invite: [["channel", "members"], { channel: "string", members: "array" }],
      clear_context: [["agent"], { agent: "string" }],
      attach: [["path"], { path: "string", body: "string", channel: "string", to: "string", threadId: "string", mime: "string" }],
      fetch_file: [[], { id: "string", seq: "number", index: "number" }],
      react: [["seq", "emoji"], { seq: "number", emoji: "string" }],
    };
    assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(expected).sort());
    for (const tool of tools) {
      const [required, fields] = expected[tool.name]!;
      assert.equal(tool.inputSchema.type, "object");
      assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), [...required].sort(), tool.name);
      const properties = tool.inputSchema.properties ?? {};
      assert.deepEqual(Object.keys(properties).sort(), Object.keys(fields).sort(), tool.name);
      for (const [name, type] of Object.entries(fields)) {
        const property = properties[name] as Record<string, unknown>;
        assert.equal(property.type, type, `${tool.name}.${name}`);
        assert.ok(!Object.hasOwn(property, "default"), `${tool.name}.${name} acquired a schema default`);
        if (type === "array") assert.equal((property.items as Record<string, unknown>).type, "string");
      }
    }
    const enums: Array<[string, string, string[]]> = [
      ["join", "role", ["brain", "worker"]],
      ["join", "seniority", ["junior", "mid", "senior"]],
      ["create_channel", "type", ["public", "private"]],
      ["set_thread_status", "status", ["open", "in_progress", "blocked", "done"]],
    ];
    for (const [tool, field, values] of enums) {
      const schema = tools.find((entry) => entry.name === tool)!.inputSchema.properties![field] as Record<string, unknown>;
      assert.deepEqual(schema.enum, values, `${tool}.${field}`);
    }
  });

  await t.test("omitted optionals, false booleans, empty arrays and handler defaults survive real calls", async () => {
    const joined = textResult(await call("join", { role: "brain" }));
    assert.equal(joined.created, true);
    const actor = database.getAgentByName(String(joined.name))!;
    assert.equal(actor.role, "brain");
    assert.equal(actor.seniority, null);
    assert.equal(actor.focus, null);
    const withoutUnread = textResult(await call("channels", { unread: false }));
    assert.ok(!Object.hasOwn(withoutUnread, "unread"));
    const withUnread = textResult(await call("channels", { unread: true }));
    assert.equal(typeof withUnread.unread, "object");
    const created = textResult(await call("create_channel", { name: "schema-room", members: [] }));
    const channel = created.channel as { name: string; type: string; topic: string | null };
    assert.equal(channel.name, "schema-room");
    assert.equal(channel.type, "public");
    assert.equal(channel.topic, null);
    const sent = textResult(await call("send", { channel: "schema-room", body: "schema café 🧪", attachmentIds: [] }));
    assert.equal(sent.ok, true);
    const history = textResult(await call("history", { channel: "schema-room", meta: false, limit: 1 }));
    assert.ok(!Object.hasOwn(history, "threads"));
    assert.ok(!Object.hasOwn(history, "replyCounts"));
    const messages = history.messages as Array<{ body: string }>;
    assert.equal(messages[0]?.body, "schema café 🧪");
    const requiredChoice = await call("send", { body: "no destination" });
    assert.equal(requiredChoice.isError, true);
    assert.match(JSON.stringify(requiredChoice.content), /Provide channel or to/);
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ["join", {}], ["join", { role: "human" }], ["join", { role: 42 }],
    ["join", { role: "brain", seniority: null }], ["join", { role: "brain", focus: null }],
    ["join", { role: "brain", resume: 3 }], ["join", { role: "brain", project: false }],
    ["channels", { unread: "true" }], ["channels", { unread: null }],
    ["search", {}], ["search", { q: "x", limit: "1" }], ["search", { q: "x", before: null }],
    ["history", { channel: null }], ["history", { channel: "general", meta: 0 }],
    ["history", { channel: "general", threadId: null }],
    ["send", { body: 17 }], ["send", { body: "x", attachmentIds: [7] }], ["send", { body: "x", channel: null }],
    ["create_channel", { name: "x", type: "brains" }], ["create_channel", { name: "x", topic: null }],
    ["create_channel", { name: "x", members: [42] }],
    ["set_thread_status", { threadId: "x", status: "unknown" }], ["set_thread_status", { status: "open" }],
    ["invite", { channel: "general", members: "Atlas" }], ["clear_context", { agent: null }],
    ["attach", { path: null }], ["attach", { path: "not-read", body: 0 }],
    ["fetch_file", { id: null }], ["fetch_file", { seq: "1" }], ["fetch_file", { index: null }],
    ["react", { seq: "1", emoji: "✅" }], ["react", { seq: 1, emoji: [] }],
  ];
  const count = () => database.db.prepare(
    "SELECT (SELECT COUNT(*) FROM agents) AS agents, (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM channels) AS channels",
  ).get();
  const before = count();
  for (const [index, [name, args]] of invalid.entries()) {
    await t.test(`invalid production input ${index + 1}: ${name}`, async () => {
      const result = await call(name, args);
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(result.content.length, 1);
      const content = result.content[0]!;
      assert.equal(content.type, "text");
      if (content.type === "text") {
        assert.match(content.text, /Input validation error/);
        assert.ok(content.text.includes(`tool ${name}:`));
        assert.doesNotMatch(content.text, /\[object Object\]/);
      }
      assert.deepEqual(count(), before, "invalid schema input reached a mutating handler");
    });
  }
});
