import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";

async function httpJson(
  base: string,
  method: string,
  url: string,
  token: string,
  body?: unknown,
) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: (await response.json().catch(() => ({}))) as Record<string, any>,
  };
}

test("project isolation covers channels, history, search, DMs, waits, mentions, threads, and HTTP", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-project-isolation-contract-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const human = hive.getAgent("human");
  hive.createProject(human, { name: "Beta", slug: "beta" });

  const alphaBrain = hive.join({ role: "brain", project: "chapter", focus: "alpha" });
  const alphaWorker = hive.join({ role: "worker", seniority: "mid", project: "chapter", focus: "alpha-worker" });
  const betaBrain = hive.join({ role: "brain", project: "beta", focus: "beta" });
  const betaWorker = hive.join({ role: "worker", seniority: "mid", project: "beta", focus: "beta-worker" });

  const alphaGeneral = hive.getChannel("general", alphaBrain.agent.projectId);
  const betaGeneral = hive.getChannel("general", betaBrain.agent.projectId);
  assert.notEqual(alphaGeneral.id, betaGeneral.id);

  const alphaChannels = hive.listChannels(alphaBrain.agent);
  assert.ok(alphaChannels.every((channel) => channel.projectId === alphaBrain.agent.projectId));
  assert.equal(alphaChannels.some((channel) => channel.id === betaGeneral.id), false);
  const betaChannels = hive.listChannels(betaBrain.agent);
  assert.ok(betaChannels.every((channel) => channel.projectId === betaBrain.agent.projectId));
  assert.equal(betaChannels.some((channel) => channel.id === alphaGeneral.id), false);

  const alphaMessage = hive.postMessage(alphaBrain.agent, {
    channel: alphaGeneral.id,
    body: "alpha-only-search-fixture",
  });
  const betaRoot = hive.postMessage(betaBrain.agent, {
    channel: betaGeneral.id,
    body: "beta-only-search-fixture",
  });
  hive.postMessage(betaWorker.agent, {
    channel: betaGeneral.id,
    threadId: betaRoot.id,
    body: "beta-thread-reply",
  });

  assert.throws(
    () => hive.listMessages(alphaBrain.agent, betaGeneral.id, { limit: 20 }),
    /not found|Cannot read|project/i,
  );
  const betaViaLegacyGeneralRef = hive.listMessages(betaBrain.agent, alphaGeneral.id, { limit: 20 });
  assert.ok(betaViaLegacyGeneralRef.messages.some((message) => message.id === betaRoot.id));
  assert.equal(
    betaViaLegacyGeneralRef.messages.some((message) => message.id === alphaMessage.id),
    false,
    "the legacy id/name alias 'general' must resolve inside the caller's project",
  );

  const alphaSearch = hive.searchMessages(alphaBrain.agent, {
    q: "search-fixture",
    project: "chapter",
  });
  assert.ok(alphaSearch.hits.some((hit) => hit.seq === alphaMessage.seq));
  assert.equal(alphaSearch.hits.some((hit) => /beta-only/.test(hit.body)), false);
  assert.throws(
    () => hive.searchMessages(alphaBrain.agent, { q: "beta-only", project: "beta" }),
    /cannot|other project/i,
  );

  assert.throws(
    () => hive.openDm(alphaBrain.agent, betaWorker.agent.name),
    /not in your project/i,
  );
  assert.throws(
    () => hive.openDm(betaBrain.agent, alphaWorker.agent.name),
    /not in your project/i,
  );

  // A project-B message cannot wake a project-A agent, even if the text happens
  // to contain the other project's display name.
  hive.postMessage(betaBrain.agent, {
    channel: betaGeneral.id,
    body: `literal @${alphaWorker.agent.name} must not cross projects`,
  });
  const alphaIdle = await hive.wait(alphaWorker.agent, 30, undefined, { sessionId: "alpha-isolation" });
  assert.equal(alphaIdle.idle, true);

  const betaMention = hive.postMessage(betaBrain.agent, {
    channel: betaGeneral.id,
    body: `please handle @${betaWorker.agent.name}`,
  });
  const betaMail = await hive.wait(betaWorker.agent, 300, undefined, { sessionId: "beta-isolation" });
  assert.ok(betaMail.deliveryId);
  assert.ok(betaMail.mentions.some((message) => message.id === betaMention.id));
  hive.ackDelivery(betaWorker.agent, betaMail.deliveryId!, "beta-isolation");

  const betaThread = hive.threadsInChannel(betaGeneral.id).find((thread) => thread.id === betaRoot.id);
  assert.ok(betaThread);
  assert.throws(
    () => hive.setThreadStatus(alphaBrain.agent, betaRoot.id, "done"),
    /Cannot access thread/,
  );
  const unchanged = hive.threadsInChannel(betaGeneral.id).find((thread) => thread.id === betaRoot.id);
  assert.equal(unchanged?.status, "open");

  const started = startServer({ port: 0, hive, telegram: false });
  const port = await started.ready;
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    const closed = new Promise<void>((resolve) => started.server.once("close", () => resolve()));
    started.shutdown();
    await closed;
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const channelsHttp = await httpJson(base, "GET", "/api/agent/channels", alphaBrain.token);
  assert.equal(channelsHttp.status, 200);
  assert.equal(
    channelsHttp.data.channels.some((channel: { id: string }) => channel.id === betaGeneral.id),
    false,
  );

  const historyHttp = await httpJson(
    base,
    "GET",
    `/api/agent/channels/${encodeURIComponent(betaGeneral.id)}/messages`,
    alphaBrain.token,
  );
  assert.ok([403, 404].includes(historyHttp.status));

  const searchHttp = await httpJson(
    base,
    "GET",
    "/api/agent/search?q=beta-only-search-fixture&project=beta",
    alphaBrain.token,
  );
  assert.equal(searchHttp.status, 403);

  const dmHttp = await httpJson(
    base,
    "POST",
    "/api/agent/dms",
    alphaBrain.token,
    { name: betaWorker.agent.name },
  );
  assert.ok([403, 404].includes(dmHttp.status));

  const threadHttp = await httpJson(
    base,
    "POST",
    `/api/agent/threads/${betaRoot.id}/status`,
    alphaBrain.token,
    { status: "done" },
  );
  assert.equal(threadHttp.status, 403);
});
