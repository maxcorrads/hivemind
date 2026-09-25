import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
    signal: AbortSignal.timeout(5000),
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

test("project isolation covers channels, history, search, DMs, waits, mentions, threads, and HTTP", { timeout: 15_000 }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-project-isolation-contract-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  let started: ReturnType<typeof startServer> | undefined;
  t.after(async () => {
    try { await started?.shutdown(); }
    finally { hive.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  const human = hive.identity.getAgent("human");
  hive.projects.createProject(human, { name: "Beta", slug: "beta" });

  const alphaBrain = hive.identity.join({ role: "brain", project: "acme", focus: "alpha" });
  const alphaWorker = hive.identity.join({ role: "worker", seniority: "mid", project: "acme", focus: "alpha-worker" });
  const betaBrain = hive.identity.join({ role: "brain", project: "beta", focus: "beta" });
  const betaWorker = hive.identity.join({ role: "worker", seniority: "mid", project: "beta", focus: "beta-worker" });

  const alphaGeneral = hive.channels.getChannel("general", alphaBrain.agent.projectId);
  const betaGeneral = hive.channels.getChannel("general", betaBrain.agent.projectId);
  assert.notEqual(alphaGeneral.id, betaGeneral.id);

  const alphaChannels = hive.channels.listChannels(alphaBrain.agent);
  assert.ok(alphaChannels.every((channel) => channel.projectId === alphaBrain.agent.projectId));
  assert.equal(alphaChannels.some((channel) => channel.id === betaGeneral.id), false);
  const betaChannels = hive.channels.listChannels(betaBrain.agent);
  assert.ok(betaChannels.every((channel) => channel.projectId === betaBrain.agent.projectId));
  assert.equal(betaChannels.some((channel) => channel.id === alphaGeneral.id), false);

  const alphaMessage = hive.messages.postMessage(alphaBrain.agent, {
    channel: alphaGeneral.id,
    body: "alpha-only-search-fixture",
  });
  const betaRoot = hive.messages.postMessage(betaBrain.agent, {
    channel: betaGeneral.id,
    body: "beta-only-search-fixture",
  });
  hive.messages.postMessage(betaWorker.agent, {
    channel: betaGeneral.id,
    threadId: betaRoot.id,
    body: "beta-thread-reply",
  });

  assert.throws(
    () => hive.messageQueries.listMessages(alphaBrain.agent, betaGeneral.id, { limit: 20 }),
    /not found|Cannot read|project/i,
  );
  const betaViaLegacyGeneralRef = hive.messageQueries.listMessages(betaBrain.agent, alphaGeneral.id, { limit: 20 });
  assert.ok(betaViaLegacyGeneralRef.messages.some((message) => message.id === betaRoot.id));
  assert.equal(
    betaViaLegacyGeneralRef.messages.some((message) => message.id === alphaMessage.id),
    false,
    "the legacy id/name alias 'general' must resolve inside the caller's project",
  );

  const alphaSearch = hive.messageQueries.searchMessages(alphaBrain.agent, {
    q: "search-fixture",
    project: "acme",
  });
  assert.ok(alphaSearch.hits.some((hit) => hit.seq === alphaMessage.seq));
  assert.equal(alphaSearch.hits.some((hit) => /beta-only/.test(hit.body)), false);
  assert.throws(
    () => hive.messageQueries.searchMessages(alphaBrain.agent, { q: "beta-only", project: "beta" }),
    /cannot|other project/i,
  );

  assert.throws(
    () => hive.channels.openDm(alphaBrain.agent, betaWorker.agent.name),
    /not in your project/i,
  );
  assert.throws(
    () => hive.channels.openDm(betaBrain.agent, alphaWorker.agent.name),
    /not in your project/i,
  );

  // A project-B message cannot wake a project-A agent, even if the text happens
  // to contain the other project's display name.
  hive.messages.postMessage(betaBrain.agent, {
    channel: betaGeneral.id,
    body: `literal @${alphaWorker.agent.name} must not cross projects`,
  });
  const alphaSession = hive.delivery.openInboxSession(alphaWorker.agent, randomUUID());
  const betaSession = hive.delivery.openInboxSession(betaWorker.agent, randomUUID());
  const alphaIdle = await hive.delivery.wait(alphaWorker.agent, 30, t.signal, { sessionId: alphaSession });
  assert.equal(alphaIdle.idle, true);

  const betaMention = hive.messages.postMessage(betaBrain.agent, {
    channel: betaGeneral.id,
    body: `please handle @${betaWorker.agent.name}`,
  });
  const betaMail = await hive.delivery.wait(betaWorker.agent, 300, t.signal, { sessionId: betaSession });
  assert.ok(betaMail.delivery);
  assert.ok(betaMail.mentions.some((message) => message.id === betaMention.id));
  hive.delivery.acknowledgeInbox(betaWorker.agent, betaSession, betaMail.delivery.id);

  const betaThread = hive.messageQueries.threadsInChannel(betaGeneral.id).find((thread) => thread.id === betaRoot.id);
  assert.ok(betaThread);
  assert.throws(
    () => hive.messages.setThreadStatus(alphaBrain.agent, betaRoot.id, "done"),
    /Cannot access thread/,
  );
  const unchanged = hive.messageQueries.threadsInChannel(betaGeneral.id).find((thread) => thread.id === betaRoot.id);
  assert.equal(unchanged?.status, "open");

  started = startServer({ port: 0, hive, telegram: false });
  const port = await started.ready;
  const base = `http://127.0.0.1:${port}`;

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
