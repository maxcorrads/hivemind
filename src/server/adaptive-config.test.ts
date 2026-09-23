import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "./app.ts";
import { Hive } from "./hive.ts";
import { jevTopologyResponse } from "./fixtures/jev-topology.ts";
import { adaptiveRoutingPublic, loadAdaptiveRouting, saveAdaptiveRouting } from "./adaptive-config.ts";
import type { Message } from "../shared/types.ts";
import type { AdaptiveTopologyDecision, AdaptiveExecutionState } from "../shared/adaptive-topology.ts";

test("adaptive routing settings keep the TypeSafe key private and support enable/disable", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-active-routing-"));
  try {
    assert.deepEqual(adaptiveRoutingPublic(dir), {
      enabled: false, apiKeySet: false, apiKeyHint: null, model: "jev-latest", defaultModel: "jev-latest", modelPinned: false,
      fallback: "orchestrated", topologyFallback: "brain_one_worker",
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
    assert.equal(saveAdaptiveRouting(dir, { topologyFallback: "brain_multi_room" }).topologyFallback, "brain_multi_room");
    assert.throws(() => saveAdaptiveRouting(dir, { topologyFallback: "unknown" }), /topology fallback/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("enabled topology routing changes real Human delivery while disabled Auto and send retries preserve legacy mail", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-routing-http-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(async () => {
    await hive.adaptiveTopology.stop();
    hive.db.close(); rmSync(dir, { recursive: true, force: true });
  });
  const human = hive.identity.getAgent("human");
  const brain = hive.identity.join({ role: "brain", project: "chapter" });
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
  const legacyJson = await legacy.json() as { message: Message; routing: unknown };
  assert.equal(legacyJson.message.body, "Legacy request");
  assert.equal(legacyJson.routing, null);
  assert.equal(calls, 0);

  const manual = await send({ body: "Manual single request", requestId: "manual-single", routing: "single" });
  assert.equal(manual.status, 200);
  const manualJson = await manual.json() as { message: Message; routingMessage: Message;
    routing: AdaptiveTopologyDecision; adaptiveState: AdaptiveExecutionState };
  assert.equal(calls, 0, "Jev remains disabled for an explicit local choice");
  assert.equal(manualJson.message.body, "Manual single request");
  assert.equal(manualJson.routing.targetTopology, "single");
  assert.equal(manualJson.routing.providerStatus, "bypassed");
  assert.equal(manualJson.adaptiveState.lockedTopology, "single");
  assert.match(manualJson.routingMessage.body, /SINGLE/);

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
  const activeJson = await active.json() as { message: Message; routingMessage: Message;
    routing: AdaptiveTopologyDecision; adaptiveState: AdaptiveExecutionState };
  assert.equal(calls, 1);
  assert.equal(activeJson.routing.targetTopology, "single");
  assert.equal(activeJson.routing.providerStatus, "ok", "A malformed mock must not make a fallback look like successful routing");
  assert.equal(activeJson.routing.contractVersion, "adaptive-routing-v2");
  assert.equal(activeJson.adaptiveState.currentTopology, "single");
  assert.equal(activeJson.adaptiveState.lockedTopology, null);
  assert.match(activeJson.routing.routeId, /^route-/);
  assert.equal(activeJson.message.body, "Small direct request");
  assert.match(activeJson.routingMessage.body, /Hivemind adaptive topology · SINGLE/);
  assert.match(activeJson.routingMessage.body, /Do not delegate/);

  const retry = await send({ body: "Small direct request", requestId: "active-request" });
  assert.equal(retry.status, 200);
  const retried = await retry.json() as { message: Message; routing: unknown };
  assert.equal(retried.message.id, activeJson.message.id);
  assert.equal(retried.routing, null);
  assert.equal(calls, 1, "A committed send retry must not reclassify");
  const reply = await send({ body: "Thread clarification", threadId: activeJson.message.id, requestId: "reply-request" });
  assert.equal(reply.status, 200);
  const replied = await reply.json() as { routing: unknown; message: Message };
  assert.equal(replied.routing, null, "A Human reply revalidates in place instead of starting a second execution");
  assert.equal(replied.message.threadId, activeJson.message.id);
  assert.equal(calls, 2, "A Human reply is evaluated by Jev before delivery");
  const view = hive.adaptiveTopology.view(human, dm.id);
  assert.equal(view.executions?.length, 1);
  assert.equal(view.state?.executionId, activeJson.adaptiveState.executionId);
  assert.equal(view.events.at(-1)?.kind, "evaluation");
  const replayed = await send({ body: "Thread clarification", threadId: activeJson.message.id, requestId: "reply-request" });
  assert.equal(replayed.status, 200);
  assert.equal(calls, 2, "A committed reply retry must not reclassify");
});

test("public settings never expose the saved key", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-routing-public-"));
  try {
    saveAdaptiveRouting(dir, { enabled: true, apiKey: "ts_not_for_browser_9999" });
    assert.doesNotMatch(JSON.stringify(adaptiveRoutingPublic(dir)), /ts_not_for_browser/);
    assert.match(readFileSync(path.join(dir, "adaptive-routing.json"), "utf8"), /ts_not_for_browser/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
