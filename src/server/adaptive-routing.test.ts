import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "./app.ts";
import { Hive } from "./hive.ts";
import {
  adaptiveDirective,
  adaptiveRoutingPublic,
  appendAdaptiveTelemetry,
  decideAdaptiveStrategy,
  evaluateAdaptiveRequest,
  loadAdaptiveRouting,
  saveAdaptiveRouting,
  shouldRouteHumanMessage,
} from "./adaptive-routing.ts";
import type { Channel } from "../shared/types.ts";

function score(value: number, confidence = 0.9) {
  return { type: "score" as const, score: value, confidence, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 } };
}

const singleSignals = {
  single_agent_sufficiency: {
    type: "choice" as const,
    choice: "sufficient" as const,
    confidence: 0.95,
    probabilities: { sufficient: 0.95, insufficient: 0.05 },
  },
  complexity: score(0.4),
  parallelizability: score(0.4),
  coupling: score(0.4),
  specialization_need: score(0.3),
  coordination_need: score(0.3),
};

test("adaptive routing settings keep the TypeSafe key private and support enable/disable", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-active-routing-"));
  try {
    assert.deepEqual(adaptiveRoutingPublic(dir), {
      enabled: false,
      apiKeySet: false,
      apiKeyHint: null,
      model: "jev-latest",
    });
    assert.throws(() => saveAdaptiveRouting(dir, { enabled: true }), /API key is required/);
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("active strategy chooses a direct brain session only for high-confidence simple requests", () => {
  const direct = decideAdaptiveStrategy(singleSignals);
  assert.equal(direct.strategy, "single");
  assert.equal(direct.fallbackUsed, false);

  const orchestrated = decideAdaptiveStrategy({
    ...singleSignals,
    coordination_need: score(1.8),
    single_agent_sufficiency: {
      type: "choice",
      choice: "insufficient",
      confidence: 0.95,
      probabilities: { sufficient: 0.05, insufficient: 0.95 },
    },
  });
  assert.equal(orchestrated.strategy, "orchestrated");

  const uncertain = decideAdaptiveStrategy({ ...singleSignals, complexity: score(0.4, 0.2) });
  assert.equal(uncertain.strategy, "orchestrated");
  assert.equal(uncertain.reason, "low_confidence_fallback");
});

test("Jev request uses the current System One contract and returns an active decision", async () => {
  const captured: Array<{
    model?: string;
    questions?: Record<string, unknown>;
    state?: { project?: unknown };
  }> = [];
  const decision = await evaluateAdaptiveRequest(
    "Fix the typo in one local label.",
    { apiKey: "fixture-key" },
    {
      project: { slug: "chapter", name: "Chapter" },
      fetchImpl: async (_url, init) => {
        captured.push(JSON.parse(String(init?.body)) as {
          model?: string;
          questions?: Record<string, unknown>;
          state?: { project?: unknown };
        });
        return new Response(JSON.stringify({
          model: "jev-1.13.0",
          answers: singleSignals,
          usage: { input_tokens: 42, output_tokens: 12 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  );
  const outbound = captured[0]!;
  assert.equal(outbound.model, "jev-latest");
  assert.equal(Object.keys(outbound.questions ?? {}).length, 6);
  assert.deepEqual(outbound.state?.project, { slug: "chapter", name: "Chapter" });
  assert.equal(decision.strategy, "single");
  assert.equal(decision.model, "jev-1.13.0");
  assert.equal(decision.inputTokens, 42);
  assert.equal(decision.outputTokens, 12);
  assert.match(adaptiveDirective(decision), /SINGLE/);
  assert.match(adaptiveDirective(decision), /Do not delegate/);
});

test("Jev failure conservatively activates orchestration instead of blocking Human mail", async () => {
  const decision = await evaluateAdaptiveRequest(
    "Implement a feature.",
    { apiKey: "fixture-key" },
    { fetchImpl: async () => { throw new Error("offline"); } },
  );
  assert.equal(decision.strategy, "orchestrated");
  assert.equal(decision.fallbackUsed, true);
  assert.equal(decision.providerStatus, "unavailable");
  assert.match(adaptiveDirective(decision), /ORCHESTRATED/);
});

test("only new top-level Human messages in a brain DM are active-routing candidates", () => {
  const channel = {
    id: "dm",
    name: "Human, Brain",
    type: "dm",
    topic: null,
    memberIds: ["human", "brain-id"],
    projectId: "project-id",
    project: "chapter",
    createdBy: "human",
    createdAt: 1,
  } as Channel;
  const brains = new Set(["brain-id"]);
  assert.equal(shouldRouteHumanMessage(channel, "Do this", null, brains), true);
  assert.equal(shouldRouteHumanMessage(channel, "Do this", "thread-id", brains), false);
  assert.equal(shouldRouteHumanMessage(channel, "   ", null, brains), false);
  assert.equal(shouldRouteHumanMessage({ ...channel, type: "public" }, "Do this", null, brains), false);
});

test("enabled Jev routing changes real Human-to-brain delivery while disabled mode preserves legacy mail", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-routing-http-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => {
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const human = hive.getAgent("human");
  const brain = hive.join({ role: "brain", project: "chapter" });
  const dm = hive.openDm(human, brain.agent.name);
  const app = createApp(hive);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(String(input), "https://api.typesafe.ai/v1/systemone");
    calls++;
    return new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: singleSignals,
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const legacy = await app.request(`/api/ui/channels/${dm.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Legacy request", requestId: "legacy-request" }),
  });
  assert.equal(legacy.status, 200);
  const legacyJson = await legacy.json() as { message: { body: string }; routing: unknown };
  assert.equal(legacyJson.message.body, "Legacy request");
  assert.equal(legacyJson.routing, null);
  assert.equal(calls, 0);

  const settingsResponse = await app.request("/api/ui/adaptive-routing", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, apiKey: "fixture-key" }),
  });
  assert.equal(settingsResponse.status, 200);
  const settingsJson = await settingsResponse.json() as {
    enabled: boolean; apiKeySet: boolean; apiKeyHint: string | null; apiKey?: string;
  };
  assert.equal(settingsJson.enabled, true);
  assert.equal(settingsJson.apiKeySet, true);
  assert.equal(settingsJson.apiKey, undefined);

  const active = await app.request(`/api/ui/channels/${dm.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Small direct request", requestId: "active-request" }),
  });
  assert.equal(active.status, 200);
  const activeJson = await active.json() as {
    message: { id: string; body: string };
    routingMessage: { id: string; body: string };
    routing: { strategy: string; routeId: string };
  };
  assert.equal(calls, 1);
  assert.equal(activeJson.routing.strategy, "single");
  assert.match(activeJson.routing.routeId, /^route-/);
  assert.equal(activeJson.message.body, "Small direct request");
  assert.match(activeJson.routingMessage.body, /Hivemind adaptive routing · SINGLE/);
  assert.match(activeJson.routingMessage.body, /Do not delegate/);

  const retry = await app.request(`/api/ui/channels/${dm.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Small direct request", requestId: "active-request" }),
  });
  assert.equal(retry.status, 200);
  const retryJson = await retry.json() as { message: { id: string }; routing: unknown };
  assert.equal(retryJson.message.id, activeJson.message.id);
  assert.equal(retryJson.routing, null);
  assert.equal(calls, 1, "retry must reuse the committed Human request without another Jev call");

  const reply = await app.request(`/api/ui/channels/${dm.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Thread clarification", threadId: activeJson.message.id, requestId: "reply-request" }),
  });
  assert.equal(reply.status, 200);
  assert.equal(calls, 1, "thread replies must not trigger a new Jev call");
});

test("public settings and private telemetry never expose the saved key or duplicate request text", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-routing-public-"));
  try {
    saveAdaptiveRouting(dir, { enabled: true, apiKey: "ts_not_for_browser_9999" });
    assert.doesNotMatch(JSON.stringify(adaptiveRoutingPublic(dir)), /ts_not_for_browser/);
    assert.match(readFileSync(path.join(dir, "adaptive-routing.json"), "utf8"), /ts_not_for_browser/);

    appendAdaptiveTelemetry(dir, {
      routeId: "route-fixture",
      strategy: "single",
      reason: "high_confidence_single_sufficient",
      fallbackUsed: false,
      providerStatus: "ok",
      model: "jev-fixture",
      latencyMs: 12,
      inputTokens: 20,
      outputTokens: 5,
      minimumConfidence: 0.9,
      signals: singleSignals,
    }, "secret-ish request text", { id: "project-id", slug: "chapter" });

    const telemetryPath = path.join(dir, "adaptive-routing-decisions.jsonl");
    const telemetry = readFileSync(telemetryPath, "utf8");
    assert.equal(statSync(telemetryPath).mode & 0o777, 0o600);
    assert.doesNotMatch(telemetry, /secret-ish request text|ts_not_for_browser/);
    assert.match(telemetry, /"requestHash":/);
    assert.match(telemetry, /"inputTokens":20/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
