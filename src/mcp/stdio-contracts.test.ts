import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Hive } from "../server/hive.ts";
import { startServer } from "../server/serve.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type Rpc = Record<string, any>;

class RpcChild {
  readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private waiters = new Map<number, { resolve: (value: Rpc) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, ["--import", "tsx", path.join(root, "src/cli.ts"), "mcp"], {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(String(chunk)));
    this.child.on("exit", (code, signal) => {
      const error = new Error(`MCP exited before response: ${code ?? signal ?? "unknown"}`);
      for (const waiter of this.waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.waiters.clear();
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Rpc;
      if (typeof message.id !== "number") continue;
      const waiter = this.waiters.get(message.id);
      if (!waiter) continue;
      this.waiters.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  request(id: number, method: string, params: unknown, timeoutMs = 8_000): Promise<Rpc> {
    assert.equal(this.waiters.has(id), false, `duplicate JSON-RPC id ${id}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`MCP timeout waiting for ${method} id=${id}`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize(id = 1) {
    const response = await this.request(id, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "hivemind-stdio-contract", version: "0" },
    });
    assert.ok(response.result);
    this.notify("notifications/initialized");
  }

  async tool(id: number, name: string, args: Record<string, unknown> = {}, timeoutMs = 8_000) {
    return this.request(id, "tools/call", { name, arguments: args }, timeoutMs);
  }

  stop() {
    if (!this.child.killed) this.child.kill("SIGTERM");
  }
}

function toolJson(response: Rpc): Record<string, any> {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.ok(response.result);
  assert.equal(response.result.isError, undefined);
  const text = response.result.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

test("real MCP stdio covers join, at-least-once restart, acknowledgement, and cancellation", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-mcp-stdio-delivery-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const originalWait = hive.wait.bind(hive);
  let observeCancellation = false;
  let waitStartedResolve: (() => void) | undefined;
  let waitAbortedResolve: (() => void) | undefined;
  hive.wait = async (actor, timeoutMs, signal, opts) => {
    if (observeCancellation && signal) {
      waitStartedResolve?.();
      signal.addEventListener("abort", () => waitAbortedResolve?.(), { once: true });
    }
    return originalWait(actor, timeoutMs, signal, opts);
  };
  const started = startServer({ port: 0, hive, telegram: false });
  const port = await started.ready;
  const base = `http://127.0.0.1:${port}`;
  const children: RpcChild[] = [];
  t.after(async () => {
    for (const child of children) child.stop();
    const closed = new Promise<void>((resolve) => started.server.once("close", () => resolve()));
    started.shutdown();
    await closed;
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HIVEMIND_URL: base,
    HIVEMIND_HOME: dir,
  };
  delete baseEnv.HIVEMIND_TOKEN;

  const first = new RpcChild(baseEnv);
  children.push(first);
  await first.initialize();
  const joined = toolJson(await first.tool(2, "join", { role: "worker", seniority: "mid", focus: "stdio" }));
  assert.equal(joined.created, true);
  assert.equal(typeof joined.token, "string");
  const token = joined.token as string;
  const agent = hive.agentByToken(token);
  const human = hive.getAgent("human");
  const dm = hive.openDm(human, agent.name);

  const message1 = hive.postMessage(human, { channel: dm.id, body: "stdio survives process restart" });
  const delivered1 = toolJson(await first.tool(3, "wait"));
  const delivered1Seq = delivered1.mail?.[0]?.seq ?? delivered1.messages?.[0]?.seq;
  assert.equal(delivered1Seq, message1.seq);
  assert.equal(typeof delivered1.deliveryId, "string");
  const cursorBeforeRestart = (
    hive.db.prepare("SELECT inbox_cursor FROM agents WHERE id = ?").get(agent.id) as { inbox_cursor: number }
  ).inbox_cursor;
  assert.ok(cursorBeforeRestart < message1.seq, "delivery must not acknowledge itself");

  first.stop();

  const second = new RpcChild({ ...baseEnv, HIVEMIND_TOKEN: token });
  children.push(second);
  await second.initialize(10);
  const replay = toolJson(await second.tool(11, "wait"));
  const replaySeq = replay.mail?.[0]?.seq ?? replay.messages?.[0]?.seq;
  assert.equal(replaySeq, message1.seq);
  assert.notEqual(replay.deliveryId, delivered1.deliveryId);
  assert.ok(
    (
      hive.db.prepare("SELECT inbox_cursor FROM agents WHERE id = ?").get(agent.id) as { inbox_cursor: number }
    ).inbox_cursor < message1.seq,
  );

  const message2 = hive.postMessage(human, { channel: dm.id, body: "second stdio message" });
  const delivered2 = toolJson(await second.tool(12, "wait"));
  const delivered2Seq = delivered2.mail?.[0]?.seq ?? delivered2.messages?.[0]?.seq;
  assert.equal(delivered2Seq, message2.seq);
  assert.ok(
    (
      hive.db.prepare("SELECT inbox_cursor FROM agents WHERE id = ?").get(agent.id) as { inbox_cursor: number }
    ).inbox_cursor >= message1.seq,
    "starting the next wait acknowledges the previous host-visible result",
  );
  assert.ok(
    (
      hive.db.prepare("SELECT inbox_cursor FROM agents WHERE id = ?").get(agent.id) as { inbox_cursor: number }
    ).inbox_cursor < message2.seq,
  );

  // The next wait acknowledges message2, then blocks. MCP cancellation
  // notifications do not require a JSON-RPC response, so observe propagation
  // at the actual server-side AbortSignal instead of waiting for a reply.
  observeCancellation = true;
  const waitStarted = new Promise<void>((resolve) => {
    waitStartedResolve = resolve;
  });
  const waitAborted = new Promise<void>((resolve) => {
    waitAbortedResolve = resolve;
  });
  second.child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "wait", arguments: {} },
    })}\n`,
  );
  await waitStarted;
  second.notify("notifications/cancelled", { requestId: 13, reason: "fixture cancellation" });
  await Promise.race([
    waitAborted,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("MCP cancellation did not reach server wait")), 4_000),
    ),
  ]);
  observeCancellation = false;
  assert.ok(
    (
      hive.db.prepare("SELECT inbox_cursor FROM agents WHERE id = ?").get(agent.id) as { inbox_cursor: number }
    ).inbox_cursor >= message2.seq,
  );
  assert.equal(
    hive.db.prepare(
      "SELECT COUNT(*) AS n FROM inbox_deliveries WHERE agent_id = ? AND status = 'in_flight'",
    ).get(agent.id) as { n: number }).n,
    0,
    "cancelled empty wait must not create an in-flight delivery",
  );

  const message3 = hive.postMessage(human, { channel: dm.id, body: "mail after cancelled wait" });
  const afterCancel = toolJson(await second.tool(14, "wait"));
  const afterCancelSeq = afterCancel.mail?.[0]?.seq ?? afterCancel.messages?.[0]?.seq;
  assert.equal(afterCancelSeq, message3.seq);
});

test("real MCP stdio treats invalid credentials as a fatal wait failure", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-mcp-stdio-auth-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const started = startServer({ port: 0, hive, telegram: false });
  const port = await started.ready;
  const bad = new RpcChild({
    ...process.env,
    HIVEMIND_URL: `http://127.0.0.1:${port}`,
    HIVEMIND_HOME: dir,
    HIVEMIND_TOKEN: "hm_invalid_stdio_fixture",
  });

  t.after(async () => {
    bad.stop();
    const closed = new Promise<void>((resolve) => started.server.once("close", () => resolve()));
    started.shutdown();
    await closed;
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await bad.initialize();
  const response = await bad.tool(2, "wait", {}, 4_000);
  assert.ok(response.error || response.result?.isError);
  const serialized = JSON.stringify(response);
  assert.match(serialized, /Invalid token|401/i);
});
