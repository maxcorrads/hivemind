import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hive } from "../server/hive.ts";
import { startServer } from "../server/serve.ts";
import type { Agent, Message, WaitResult } from "../shared/types.ts";

test("direct bot HTTP → real stdio MCP delivers deduplicated context/files, then fetches on request", { timeout: 20_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-mcp-bot-"));
  const hive = new Hive(path.join(dir, "data", "hive.db"));
  const server = startServer({ port: 0, hive, telegram: false });
  const port = await server.ready;
  const client = new Client({ name: "local-bot-fixture", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "src/cli.ts"), "mcp"],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HIVEMIND_HOME: path.join(dir, "identities"), HIVEMIND_URL: `http://127.0.0.1:${port}` },
    stderr: "pipe",
  });
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `MCP ${name} failed`);
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((item) => item.type === "text")?.text;
    assert.ok(text, `${name} must return text`);
    return JSON.parse(text) as T;
  };
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    await call("join", { role: "brain", project: "chapter" });
    const brain = hive.listAgents().find((agent) => agent.role === "brain") as Agent;
    assert.ok(brain);
    const human = hive.getAgent("human");
    const channel = hive.createChannel(human, { name: "Local MCP test", project: "chapter", type: "private", memberNames: [brain.name] });
    const thread = hive.postMessage(human, { channel: channel.id, body: "Invented problem" });
    const bot = hive.createBot(human, channel.projectId, { name: "FixtureBot" });
    hive.invite(human, channel.id, [bot.bot.name]);
    const url = `http://127.0.0.1:${port}`;
    const uploaded = await fetch(url + '/api/bot/files', {
      method: 'POST', headers: { Authorization: 'Bearer ' + bot.token, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'notes.txt', 'X-File-Mime': 'text/plain' },
      body: 'invented attachment contents',
    });
    assert.equal(uploaded.status, 201);
    const attachment = await uploaded.json() as { file: { id: string } };
    const event = { eventId: 'one', body: 'An invented update', threadId: thread.id,
      origin: { label: 'Generic source', author: 'Fixture author' }, attachmentIds: [attachment.file.id] };
    const send = () => fetch(url + '/api/bot/channels/' + channel.id + '/messages', {
      method: 'POST', headers: { Authorization: 'Bearer ' + bot.token, 'Content-Type': 'application/json' }, body: JSON.stringify(event),
    });
    const sent = await send(); assert.equal(sent.status, 201);
    const first = await sent.json() as { message: Message };
    const retry = await send(); assert.equal(retry.status, 200);
    const repeated = await retry.json() as { message: Message; duplicate: boolean };
    assert.equal(repeated.duplicate, true); assert.equal(repeated.message.id, first.message.id);
    const mail = await call<WaitResult>("wait");
    assert.equal(mail.mail!.filter(entry => entry.botEvent?.eventId === 'one').length, 1);
    const observation = mail.mail!.find((entry) => entry.botEvent?.eventId === "one")!;
    assert.equal(observation.authorRole, "bot");
    const file = observation.attachments![0]!;
    assert.equal(file.name, "notes.txt");
    assert.equal(JSON.stringify(mail).includes("invented attachment contents"), false);
    const history = await call<{ messages: Message[] }>("history", { channel: channel.id, threadId: thread.id });
    assert.equal(history.messages.find((m) => m.authorRole === "bot")?.botEvent?.origin?.label, "Generic source");
    const fetched = await call<{ path: string; mime: string }>("fetch_file", { id: file.id });
    assert.equal(path.dirname(realpathSync(fetched.path)), realpathSync(path.join(dir, ".hivemind-inbox")));
    assert.equal(readFileSync(fetched.path, "utf8"), "invented attachment contents");
  } finally {
    await client.close();
    await transport.close();
    server.shutdown();
    server.server.closeAllConnections();
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
