import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "./app.ts";
import { Hive } from "./hive.ts";
import { jevTopologyResponse } from "./fixtures/jev-topology.ts";
import {
  adaptiveDirective, adaptiveRoutingPublic, appendAdaptiveTelemetry,
  decideAdaptiveStrategy, evaluateAdaptiveRequest, loadAdaptiveRouting,
  saveAdaptiveRouting, shouldRouteHumanMessage,
} from "./adaptive-routing.ts";
import type { Channel, Message } from "../shared/types.ts";
import type { AdaptiveTopologyDecision, AdaptiveExecutionState } from "../shared/adaptive-topology.ts";

function score(value: number, confidence = 0.9) {
  return { type: "score" as const, score: value, confidence, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 } };
}
const singleSignals = {
  single_agent_sufficiency: { type: "choice" as const, choice: "sufficient" as const,
    confidence: 0.95, probabilities: { sufficient: 0.95, insufficient: 0.05 } },
  complexity: score(0.4), parallelizability: score(0.4), coupling: score(0.4),
  specialization_need: score(0.3), coordination_need: score(0.3),
};

test("adaptive routing settings keep the TypeSafe key private and support enable/disable", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-active-routing-"));
  try {
    assert.deepEqual(adaptiveRoutingPublic(dir), {
      enabled: false, apiKeySet: false, apiKeyHint: null, model: "jev-latest",
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

test("v1 benchmark strategy selects direct work only for high-confidence simple requests", () => {
  const direct = decideAdaptiveStrategy(singleSignals);
  assert.equal(direct.strategy, "single");
  assert.equal(direct.fallbackUsed, false);
  const orchestrated = decideAdaptiveStrategy({ ...singleSignals, coordination_need: score(1.8),
    single_agent_sufficiency: { type: "choice", choice: "insufficient", confidence: 0.95,
      probabilities: { sufficient: 0.05, insufficient: 0.95 } } });
  assert.equal(orchestrated.strategy, "orchestrated");
  const uncertain = decideAdaptiveStrategy({ ...singleSignals, complexity: score(0.4, 0.2) });
  assert.equal(uncertain.strategy, "orchestrated");
  assert.equal(uncertain.reason, "low_confidence_fallback");
  const cheaper = decideAdaptiveStrategy({ ...singleSignals, complexity: score(0.4, 0.2) }, "single");
  assert.equal(cheaper.strategy, "single");
  assert.equal(cheaper.fallbackUsed, true);
});

test("v1 evaluator preserves its System One contract and measured usage", async () => {
  const captured: Array<{ model?: string; questions?: Record<string, unknown>; state?: { project?: unknown } }> = [];
  const decision = await evaluateAdaptiveRequest("Fix the typo in one local label.", { apiKey: "fixture-key" }, {
    project: { slug: "chapter", name: "Chapter" },
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body)));
      return Response.json({ model: "jev-fixture-v1", answers: singleSignals, usage: { input_tokens: 42, output_tokens: 12 } });
    },
  });
  const outbound = captured[0]!;
  assert.equal(outbound.model, "jev-latest");
  assert.equal(Object.keys(outbound.questions ?? {}).length, 6);
  assert.deepEqual(outbound.state?.project, { slug: "chapter", name: "Chapter" });
  assert.equal(decision.strategy, "single");
  assert.equal(decision.model, "jev-fixture-v1");
  assert.equal(decision.inputTokens, 42);
  assert.equal(decision.outputTokens, 12);
  assert.match(adaptiveDirective(decision), /SINGLE/);
  assert.match(adaptiveDirective(decision), /Do not delegate/);
});

test("v1 evaluator retains configurable failure fallback", async () => {
  const failed = async () => { throw new Error("offline"); };
  const decision = await evaluateAdaptiveRequest("Implement a feature.", { apiKey: "fixture-key" }, { fetchImpl: failed });
  assert.equal(decision.strategy, "orchestrated");
  assert.equal(decision.fallbackUsed, true);
  assert.equal(decision.providerStatus, "unavailable");
  assert.match(adaptiveDirective(decision), /ORCHESTRATED/);
  const single = await evaluateAdaptiveRequest("Implement a feature.", { apiKey: "fixture-key", fallback: "single" }, { fetchImpl: failed });
  assert.equal(single.strategy, "single");
  assert.equal(single.fallbackUsed, true);
  assert.match(adaptiveDirective(single), /SINGLE/);
});

test("only new top-level Human messages in a brain DM start adaptive execution", () => {
  const channel: Channel = { id: "dm", name: "Human, Brain", type: "dm", topic: null,
    memberIds: ["human", "brain-id"], projectId: "project-id", project: "chapter", createdBy: "human", createdAt: 1 };
  const brains = new Set(["brain-id"]);
  assert.equal(shouldRouteHumanMessage(channel, "Do this", null, brains), true);
  assert.equal(shouldRouteHumanMessage(channel, "Do this", "thread-id", brains), false);
  assert.equal(shouldRouteHumanMessage(channel, "   ", null, brains), true);
  assert.equal(shouldRouteHumanMessage({ ...channel, type: "public" }, "Do this", null, brains), false);
});

test("enabled topology routing changes real Human delivery while disabled Auto and send retries preserve legacy mail", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-routing-http-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(async () => {
    await hive.adaptiveTopology.stop();
    hive.db.close(); rmSync(dir, { recursive: true, force: true });
  });
  const human = hive.getAgent("human");
  const brain = hive.join({ role: "brain", project: "chapter" });
  const dm = hive.openDm(human, brain.agent.name);
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
  assert.equal(calls, 1, "A Human reply must not start a second execution");
});

test("public settings and private telemetry never expose the saved key or duplicate request text", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-routing-public-"));
  try {
    saveAdaptiveRouting(dir, { enabled: true, apiKey: "ts_not_for_browser_9999" });
    assert.doesNotMatch(JSON.stringify(adaptiveRoutingPublic(dir)), /ts_not_for_browser/);
    assert.match(readFileSync(path.join(dir, "adaptive-routing.json"), "utf8"), /ts_not_for_browser/);
    appendAdaptiveTelemetry(dir, { routeId: "route-fixture", strategy: "single", reason: "high_confidence_single_sufficient",
      fallbackUsed: false, providerStatus: "ok", model: "jev-fixture", latencyMs: 12,
      inputTokens: 20, outputTokens: 5, minimumConfidence: 0.9, signals: singleSignals,
    }, "secret-ish request text", { id: "project-id", slug: "chapter" });
    const file = path.join(dir, "adaptive-routing-decisions.jsonl");
    const text = readFileSync(file, "utf8");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(text, /secret-ish request text|ts_not_for_browser/);
    assert.match(text, /"requestHash":/);
    assert.match(text, /"inputTokens":20/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
