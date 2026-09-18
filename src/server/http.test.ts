import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";

async function json(
  base: string,
  method: string,
  url: string,
  body?: unknown,
  token?: string,
) {
  let cookie: string | undefined;
  if (url.startsWith("/api/ui/")) {
    const bootstrap = await fetch(`${base}/api/ui/session`, {
      method: "POST", headers: { origin: base, "content-type": "application/json" },
    });
    assert.equal(bootstrap.status, 200);
    cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    await bootstrap.body?.cancel();
    assert.ok(cookie);
  }
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie, origin: base } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, data };
}

test("HTTP protocol: join, isolate, wait, Human admin", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-http-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const started = startServer({ port: 0, hive, telegram: false });
  const port = await started.ready;
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await json(base, "GET", "/api/health");
    assert.equal(health.data.ok, true);

    const snap = await json(base, "GET", "/api/ui/snapshot");
    assert.equal(snap.data.you.name, "Human");
    assert.ok(snap.data.projects.some((p: { slug: string }) => p.slug === "chapter"));
    assert.ok(snap.data.channels.some((c: { name: string }) => c.name === "brains"));

    const brain = await json(base, "POST", "/api/agent/join", { role: "brain", focus: "coord" });
    const worker = await json(base, "POST", "/api/agent/join", {
      role: "worker",
      seniority: "senior",
      focus: "frontend",
    });
    assert.equal(brain.status, 200);
    assert.equal(worker.status, 200);
    const brainTok = brain.data.token as string;
    const workerTok = worker.data.token as string;
    const workerName = worker.data.agent.name as string;
    const brainName = brain.data.agent.name as string;

    const workerCh = await json(base, "GET", "/api/agent/channels", undefined, workerTok);
    assert.ok(!workerCh.data.channels.some((c: { name: string }) => c.name === "brains"));

    const mention = await json(
      base,
      "POST",
      "/api/agent/channels/general/messages",
      { body: "hello @Human" },
      workerTok,
    );
    assert.equal(mention.status, 403);

    await json(base, "POST", "/api/ui/channels/general/messages", {
      body: "public chatter only",
    });
    const idle = await json(base, "POST", "/api/agent/wait", { timeoutMs: 400 }, workerTok);
    assert.equal(idle.data.idle, true);

    await json(base, "POST", "/api/agent/dms", { name: workerName }, brainTok);
    await json(
      base,
      "POST",
      `/api/agent/channels/general/messages`,
      { body: "ignore" },
      brainTok,
    );
    const dm = await json(base, "POST", "/api/agent/dms", { name: workerName }, brainTok);
    await json(
      base,
      "POST",
      `/api/agent/channels/${encodeURIComponent(dm.data.channel.id)}/messages`,
      { body: "build the login form" },
      brainTok,
    );
    const mail = await json(base, "POST", "/api/agent/wait", { timeoutMs: 800 }, workerTok);
    assert.equal(mail.data.idle, false);
    const bodies = [...mail.data.messages, ...mail.data.mentions].map((m: { body: string }) => m.body);
    assert.ok(bodies.some((b: string) => /login/.test(b)));

    const after = await json(base, "GET", "/api/ui/snapshot");
    assert.ok(after.data.channels.some((c: { type: string }) => c.type === "dm"));
    assert.ok(after.data.agents.some((a: { name: string }) => a.name === workerName));
    assert.ok(after.data.agents.some((a: { name: string }) => a.name === brainName));
    assert.equal(typeof after.data.queued, "object");
    assert.equal(after.data.queued[worker.data.agent.id] ?? 0, 0);

    const room = await json(
      base,
      "POST",
      "/api/agent/channels",
      { name: "login-room", type: "private", memberNames: [workerName] },
      brainTok,
    );
    assert.equal(room.status, 200);
    const invited = await json(
      base,
      "GET",
      `/api/agent/channels/${room.data.channel.id}/messages`,
      undefined,
      workerTok,
    );
    assert.equal(invited.status, 200);
    assert.equal(invited.data.threads, undefined);
    assert.equal(invited.data.replyCounts, undefined);
    const fatLimit = await json(
      base,
      "GET",
      `/api/agent/channels/${room.data.channel.id}/messages?limit=50`,
      undefined,
      workerTok,
    );
    assert.equal(fatLimit.data.threads, undefined);
    const withMeta = await json(
      base,
      "GET",
      `/api/agent/channels/${room.data.channel.id}/messages?meta=1`,
      undefined,
      workerTok,
    );
    assert.ok(withMeta.data.threads);

    await json(base, "POST", "/api/agent/channels/brains/messages", { body: "oauth secret for brains" }, brainTok);
    const uiSearch = await json(base, "GET", "/api/ui/search?q=oauth&project=chapter");
    assert.equal(uiSearch.status, 200);
    assert.ok(uiSearch.data.hits.some((h: { body: string }) => /oauth secret/.test(h.body)));
    const workerSearch = await json(base, "GET", "/api/agent/search?q=oauth", undefined, workerTok);
    assert.equal(workerSearch.status, 200);
    assert.equal(workerSearch.data.hits.some((h: { body: string }) => /oauth secret/.test(h.body)), false);
    const workerBrains = await json(base, "GET", "/api/agent/search?q=oauth&channel=brains", undefined, workerTok);
    assert.equal(workerBrains.status, 403);
    const noProject = await json(base, "GET", "/api/ui/search?q=oauth");
    assert.equal(noProject.status, 400);

    const humanDm = await json(base, "POST", "/api/ui/dms", { name: workerName });
    await json(base, "POST", `/api/ui/channels/${humanDm.data.channel.id}/messages`, {
      body: "Human override: use the existing settings component",
    });
    const reply = await json(
      base,
      "POST",
      `/api/agent/channels/${humanDm.data.channel.id}/messages`,
      { body: "Understood, using the existing component." },
      workerTok,
    );
    assert.equal(reply.status, 200);

    const clear = await json(base, "POST", "/api/ui/clear-context", { name: workerName });
    assert.equal(clear.status, 200);
    assert.equal(clear.data.message.control, "clear_context");

    await json(base, "POST", "/api/agent/channels/general/messages", { body: "goal please @Human" }, brainTok);
    const beforeSeen = await json(base, "GET", "/api/ui/snapshot");
    assert.ok((beforeSeen.data.unread.general ?? 0) > 0);
    assert.ok(beforeSeen.data.mentions.length > 0);
    const seen = await json(base, "POST", "/api/ui/mentions/seen");
    assert.equal(seen.status, 200);
    assert.equal(seen.data.messages.length, 0);
    const remaining = hive.listMessages(hive.getAgent("human"), "general", { limit: 200 }).messages
      .filter((message) => message.authorId !== "human" && !message.mentions.includes("human"));
    assert.equal(seen.data.unread.general ?? 0, remaining.length);
    assert.ok(remaining.length > 0);
    const read = await json(base, "POST", "/api/ui/read", {
      channelId: "general", messageSeqs: remaining.map((message) => message.seq),
    });
    assert.equal(read.status, 200);
    assert.equal(read.data.unread.general, 0);
  } finally {
    await started.shutdown();
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Human Telegram UI saves settings and never returns the bot token", async t => {
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("https://api.telegram.org/")) return Promise.resolve(Response.json({ ok: true, result: { id: 42, is_bot: true } }));
    return originalFetch(url, init);
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-http-tg-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const started = startServer({ port: 0, hive, telegram: false });
  const port = await started.ready;
  const base = `http://127.0.0.1:${port}`;
  const token = "123456:SECRET-telegram-token-ui";
  try {
    const put = await json(base, "PUT", "/api/ui/telegram", {
      botToken: token,
      allowUserIds: [42],
      projects: { chapter: { groupChatId: -1001 } },
    });
    assert.equal(put.status, 200);
    assert.equal(put.data.tokenSet, true);
    assert.equal(put.data.configured, true);
    assert.equal(put.data.projects.chapter, -1001);
    assert.ok(!JSON.stringify(put.data).includes(token));
    const got = await json(base, "GET", "/api/ui/telegram");
    assert.equal(got.data.tokenHint, "…n-ui");
    assert.ok(!JSON.stringify(got.data).includes(token));
    const keep = await json(base, "PUT", "/api/ui/telegram", {
      allowUserIds: [42],
      projects: { chapter: { groupChatId: -1002 } },
    });
    assert.equal(keep.data.projects.chapter, -1002);
    assert.ok(!JSON.stringify(keep.data).includes(token));
    const bad = await json(base, "PUT", "/api/ui/telegram", {
      allowUserIds: [42],
      projects: { missing: { groupChatId: -9 } },
    });
    assert.equal(bad.status, 404);
    const other = await json(base, "POST", "/api/ui/projects", { name: "Altro", slug: "altro" });
    assert.equal(other.status, 200);
    const mapped = await json(base, "PUT", "/api/ui/telegram", {
      allowUserIds: [42],
      projects: { chapter: { groupChatId: -1002 }, altro: { groupChatId: -1003 } },
    });
    assert.equal(mapped.data.projects.altro, -1003);
    const live = await json(base, "POST", "/api/agent/join", { role: "brain", project: "altro" });
    const blocked = await json(base, "DELETE", "/api/ui/projects/altro");
    assert.equal(blocked.status, 409);
    const stillMapped = await json(base, "GET", "/api/ui/telegram");
    assert.equal(stillMapped.data.projects.altro, -1003);
    const badSlug = await json(base, "DELETE", "/api/ui/projects/NOPE!");
    assert.equal(badSlug.status, 400);
    hive.setOffline(live.data.agent.id);
    const gone = await json(base, "DELETE", "/api/ui/projects/altro");
    assert.equal(gone.status, 200);
    const snap = await json(base, "GET", "/api/ui/snapshot");
    assert.equal(snap.data.projects.some((p: { slug: string }) => p.slug === "altro"), false);
    const tg = await json(base, "GET", "/api/ui/telegram");
    assert.equal(tg.data.projects.altro, undefined);
    assert.equal(tg.data.projects.chapter, -1002);
  } finally {
    await started.shutdown();
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
