import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "./app.ts";
import { Hive } from "./hive.ts";
import { jevTopologyResponse } from "./fixtures/jev-topology.ts";
import { adaptiveRoutingPublic, cachedAdaptiveRouting, loadAdaptiveRouting, saveAdaptiveRouting } from "./adaptive-config.ts";
import type { Message } from "../shared/types.ts";

test("adaptive routing settings keep the TypeSafe key private and support enable/disable", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-active-routing-"));
  try {
    assert.deepEqual(adaptiveRoutingPublic(dir), {
      enabled: false, apiKeySet: false, apiKeyHint: null, model: "jev-latest", defaultModel: "jev-latest", modelPinned: false,
    });
    assert.throws(() => saveAdaptiveRouting(dir, { enabled: true }), /API key is required/);
    assert.throws(() => saveAdaptiveRouting(dir, null), /must be an object/);
    assert.throws(() => saveAdaptiveRouting(dir, { enabled: false, extra: true }), /Unknown adaptive routing setting/);
    const saved = saveAdaptiveRouting(dir, { enabled: true, apiKey: "ts_fixture_secret_1234" });
    assert.equal(saved.enabled, true);
    assert.equal(saved.apiKeySet, true);
    assert.equal(saved.apiKeyHint, "…1234");
    assert.equal(JSON.stringify(saved).includes("ts_fixture_secret"), false);
    assert.equal(loadAdaptiveRouting(dir)?.apiKey, "ts_fixture_secret_1234");
    assert.equal(statSync(path.join(dir, "adaptive-routing.json")).mode & 0o777, 0o600);
    const disabled = saveAdaptiveRouting(dir, { enabled: false });
    assert.equal(disabled.enabled, false);
    assert.equal(loadAdaptiveRouting(dir)?.apiKey, "ts_fixture_secret_1234");
    // The enforced-mode fallbacks were removed (#211) and are no longer accepted (#214).
    assert.throws(() => saveAdaptiveRouting(dir, { fallback: "single" }), /Unknown adaptive routing setting/);
    assert.throws(() => saveAdaptiveRouting(dir, { topologyFallback: "brain_multi_room" }), /Unknown adaptive routing setting/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(dir, "adaptive-routing.json"), "utf8"))).sort(), ["apiKey", "enabled", "version"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("enabling Jev adds advice to Human delivery without changing it; disabled Jev and send retries make no call", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-routing-http-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(async () => {
    await hive.adaptiveTopology.stop();
    hive.db.close(); rmSync(dir, { recursive: true, force: true });
  });
  const human = hive.identity.getAgent("human");
  const brain = hive.identity.join({ role: "brain", project: "acme" });
  const dm = hive.channels.openDm(human, brain.agent.name);
  const app = createApp(hive);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://api.typesafe.ai/v1/systemone");
    calls++;
    return Response.json(jevTopologyResponse(String(init?.body), "single"));
  });
  const send = (body: unknown) => app.request(`/api/ui/channels/${dm.id}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const legacy = await send({ body: "Legacy request", requestId: "legacy-request" });
  assert.equal(legacy.status, 200);
  const legacyJson = await legacy.json() as { message: Message; adaptiveStates?: unknown };
  assert.equal(legacyJson.message.body, "Legacy request");
  assert.equal(legacyJson.adaptiveStates, undefined);
  assert.equal(calls, 0);

  const settings = await app.request("/api/ui/adaptive-routing", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, apiKey: "fixture-key" }),
  });
  assert.equal(settings.status, 200);
  const settingsJson = await settings.json() as { enabled: boolean; apiKeySet: boolean; apiKey?: string };
  assert.equal(settingsJson.enabled, true);
  assert.equal(settingsJson.apiKeySet, true);
  assert.equal(settingsJson.apiKey, undefined);

  const active = await send({ body: "Small direct request", requestId: "active-request" });
  assert.equal(active.status, 200);
  const activeJson = await active.json() as { message: Message; adaptiveStates?: unknown };
  assert.equal(activeJson.adaptiveStates, undefined, "the send response never waits for advice (#214)");
  await hive.adaptiveTopology.settled();
  assert.equal(calls, 1);
  const state = hive.adaptiveTopology.view(human, dm.id).state;
  assert.equal(state!.recommendation?.targetTopology, "single");
  assert.equal(state!.recommendation?.providerStatus, "ok", "A malformed mock must not look like a successful answer");
  assert.equal(state!.recommendation?.contractVersion, "adaptive-routing-v3");
  assert.match(state!.recommendation!.routeId, /^route-/);
  assert.equal(state!.advice?.plan, "single");
  assert.equal(activeJson.message.body, "Small direct request");
  assert.deepEqual(hive.messageQueries.listMessages(human, dm.id).messages.map(message => message.body),
    ["Legacy request", "Small direct request"], "Jev posts nothing");

  const retry = await send({ body: "Small direct request", requestId: "active-request" });
  assert.equal(retry.status, 200);
  await hive.adaptiveTopology.settled();
  const retried = await retry.json() as { message: Message; adaptiveStates?: unknown };
  assert.equal(retried.message.id, activeJson.message.id);
  assert.equal(retried.adaptiveStates, undefined);
  assert.equal(calls, 1, "A committed send retry must not reclassify");
  const reply = await send({ body: "Thread clarification", threadId: activeJson.message.id, requestId: "reply-request" });
  assert.equal(reply.status, 200);
  const replied = await reply.json() as { message: Message };
  await hive.adaptiveTopology.settled();
  assert.equal(hive.adaptiveTopology.view(human, dm.id).state?.executionId, state!.executionId, "A Human reply continues its request");
  assert.equal(replied.message.threadId, activeJson.message.id);
  assert.equal(calls, 2, "A Human reply is sent to Jev after delivery");
  const view = hive.adaptiveTopology.view(human, dm.id);
  assert.equal(view.executions?.length, 1);
  assert.equal(view.state?.executionId, state!.executionId);
  assert.equal(view.events.at(-1)?.kind, "advice");
  assert.equal(view.events.at(-1)?.trigger, "human_message");
  const replayed = await send({ body: "Thread clarification", threadId: activeJson.message.id, requestId: "reply-request" });
  assert.equal(replayed.status, 200);
  await hive.adaptiveTopology.settled();
  assert.equal(calls, 2, "A committed reply retry must not reclassify");
});

test("the runtime reads the settings file once and again only after a save (#214)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-routing-cache-"));
  try {
    assert.equal(cachedAdaptiveRouting(dir), null);
    saveAdaptiveRouting(dir, { enabled: true, apiKey: "ts_fixture_cache_1234" });
    assert.equal(cachedAdaptiveRouting(dir)?.enabled, true, "a save invalidates the cache");
    // A hand edit is not read on the hot path; the next save or a restart picks the file up.
    writeFileSync(path.join(dir, "adaptive-routing.json"), JSON.stringify({ version: 1, enabled: false, apiKey: "x" }));
    assert.equal(cachedAdaptiveRouting(dir)?.enabled, true);
    assert.equal(loadAdaptiveRouting(dir)?.enabled, false);
    saveAdaptiveRouting(dir, { enabled: false });
    assert.equal(cachedAdaptiveRouting(dir)?.enabled, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("public settings never expose the saved key", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-routing-public-"));
  try {
    saveAdaptiveRouting(dir, { enabled: true, apiKey: "ts_not_for_browser_9999" });
    assert.doesNotMatch(JSON.stringify(adaptiveRoutingPublic(dir)), /ts_not_for_browser/);
    assert.match(readFileSync(path.join(dir, "adaptive-routing.json"), "utf8"), /ts_not_for_browser/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
