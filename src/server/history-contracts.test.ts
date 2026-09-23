import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { childEnv, stopChild } from "../test-support/child-process.ts";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function json(base: string, url: string, token: string) {
  const res = await fetch(`${base}${url}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(rootDir, "src/cli.ts"), ...args], {
      cwd: rootDir,
      env: childEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      void stopChild(child);
      reject(new Error(`CLI timeout: ${stderr}`));
    }, 8_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`CLI exited ${code ?? signal}: ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function rpcRequest(
  child: ChildProcessWithoutNullStreams,
  id: number,
  method: string,
  params: unknown,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MCP response timeout for ${method}: ${buffer}`));
    }, 8_000);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as Record<string, any>;
        if (parsed.id === id) {
          cleanup();
          resolve(parsed);
          return;
        }
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
    };
    child.stdout.on("data", onData);
    child.on("error", onError);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

test("storage history visits 200+ eligible messages exactly once through sequence gaps", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-history-storage-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => {
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const human = hive.getAgent("human");
  const worker = hive.join({ role: "worker", seniority: "mid" }).agent;
  const dm = hive.openDm(human, worker.name);

  const root = hive.postMessage(human, { channel: "general", body: "thread root" });
  const expectedThread = [root.seq];
  for (let i = 0; i < 215; i += 1) {
    expectedThread.push(
      hive.postMessage(human, { channel: "general", threadId: root.id, body: `reply ${i}` }).seq,
    );
    hive.postMessage(human, { channel: dm.id, body: `global gap ${i}` });
  }

  const forward: number[] = [];
  let after: number | undefined;
  for (;;) {
    const page = hive.listMessages(human, "general", { threadId: root.id, afterSeq: after, limit: 17 });
    forward.push(...page.messages.map((message) => message.seq));
    if (!page.hasNewer) break;
    assert.ok(page.cursors.after !== undefined);
    after = page.cursors.after;
  }
  assert.deepEqual(forward, expectedThread);
  assert.equal(new Set(forward).size, expectedThread.length);

  const backward: number[] = [];
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = hive.listMessages(human, "general", { threadId: root.id, beforeSeq: before, limit: 19 });
    backward.unshift(...page.messages.map((message) => message.seq));
    if (!page.hasOlder) break;
    assert.ok(page.cursors.before !== undefined);
    before = page.cursors.before!;
  }
  assert.deepEqual(backward, expectedThread);
  assert.equal(new Set(backward).size, expectedThread.length);

  const final = hive.listMessages(human, "general", {
    threadId: root.id,
    afterSeq: expectedThread.at(-1),
    limit: 20,
  });
  assert.deepEqual(final.messages, []);
  assert.equal(final.hasNewer, false);

  assert.throws(
    () => hive.listMessages(human, "general", { afterSeq: 1, beforeSeq: 2 }),
    /either afterSeq or beforeSeq/,
  );
  for (const cursor of [NaN, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => hive.listMessages(human, "general", { afterSeq: cursor }),
      /nonnegative safe integer/,
    );
  }
});

test("HTTP, CLI, and real MCP stdio expose the same history cursor semantics", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-history-contract-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const human = hive.getAgent("human");
  const gapWorker = hive.join({ role: "worker", seniority: "junior", focus: "gap" });
  const dm = hive.openDm(human, gapWorker.agent.name);
  const reader = hive.join({ role: "brain", focus: "history-reader" });
  // Joins may create visible system history. Establish the cursor only after all
  // participants exist so the fixture's expected set contains only messages
  // intentionally created below.
  const startSeq = hive.latestSeq("general");
  const expected: number[] = [];

  for (let i = 0; i < 225; i += 1) {
    expected.push(hive.postMessage(human, { channel: "general", body: `root ${i}` }).seq);
    if (i % 4 === 0) hive.postMessage(human, { channel: dm.id, body: `interleaved ${i}` });
  }
  const started = startServer({ port: 0, hive, telegram: false });
  const port = await started.ready;
  const base = `http://127.0.0.1:${port}`;
  let mcp: ChildProcessWithoutNullStreams | undefined;

  t.after(async () => {
    if (mcp) await stopChild(mcp);
    const closed = new Promise<void>((resolve) => started.server.once("close", () => resolve()));
    started.shutdown();
    await closed;
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const latest = await json(base, "/api/agent/channels/general/messages?limit=20", reader.token);
  assert.equal(latest.status, 200);
  assert.deepEqual(
    latest.data.messages.map((message: { seq: number }) => message.seq),
    expected.slice(-20),
  );
  assert.equal(latest.data.hasOlder, true);
  assert.equal(latest.data.hasNewer, false);

  const first = await json(
    base,
    `/api/agent/channels/general/messages?afterSeq=${startSeq}&limit=17`,
    reader.token,
  );
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.data.messages.map((message: { seq: number }) => message.seq),
    expected.slice(0, 17),
  );
  assert.equal(first.data.cursors.after, expected[16]);

  const seen: number[] = [];
  let cursor = startSeq;
  for (;;) {
    const page = await json(
      base,
      `/api/agent/channels/general/messages?afterSeq=${cursor}&limit=31`,
      reader.token,
    );
    assert.equal(page.status, 200);
    seen.push(...page.data.messages.map((message: { seq: number }) => message.seq));
    if (!page.data.hasNewer) break;
    cursor = page.data.cursors.after;
  }
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, expected.length);

  const conflicting = await json(
    base,
    "/api/agent/channels/general/messages?afterSeq=1&beforeSeq=2",
    reader.token,
  );
  assert.equal(conflicting.status, 400);
  const invalid = await json(base, "/api/agent/channels/general/messages?afterSeq=not-a-number", reader.token);
  assert.equal(invalid.status, 400);

  const env = {
    ...process.env,
    HIVEMIND_URL: base,
    HIVEMIND_TOKEN: reader.token,
    HIVEMIND_HOME: dir,
  };
  const cli = await runCli(
    ["history", "--channel", "general", "--since", String(startSeq), "--limit", "17"],
    env,
  );
  assert.match(cli.stdout, new RegExp(`newer: history --channel general --since ${expected[16]}(?:\\s|$)`));

  mcp = spawn(process.execPath, ["--import", "tsx", path.join(rootDir, "src/cli.ts"), "mcp"], {
    cwd: rootDir,
    env: childEnv(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const init = await rpcRequest(mcp, 1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "history-contract", version: "0" },
  });
  assert.ok(init.result);
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const history = await rpcRequest(mcp, 2, "tools/call", {
    name: "history",
    arguments: { channel: "general", since: startSeq, limit: 17 },
  });
  assert.equal(history.error, undefined);
  const payload = JSON.parse(history.result.content[0].text) as {
    messages: Array<{ seq: number }>;
    cursors: { after?: number };
  };
  assert.deepEqual(payload.messages.map((message) => message.seq), expected.slice(0, 17));
  assert.equal(payload.cursors.after, expected[16]);
});
