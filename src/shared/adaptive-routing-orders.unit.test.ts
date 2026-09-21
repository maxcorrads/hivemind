import assert from "node:assert/strict";
import { test } from "node:test";
import { standingOrders } from "./standing-orders.ts";
import type { Agent } from "./types.ts";

const brain: Agent = {
  id: "brain-id", name: "Brain", role: "brain", seniority: null,
  focus: "coord", online: true, lastSeenAt: 1, createdAt: 1,
  projectId: "project-id", project: "chapter",
};

test("brain orders describe every applied topology without changing its permanent role", () => {
  const orders = standingOrders(brain);
  assert.match(orders, /Hivemind adaptive topology/);
  assert.match(orders, /SINGLE means execute in this brain session and do not delegate/);
  assert.match(orders, /BRAIN\+1 permits at most one active worker/);
  assert.match(orders, /MULTI-DM permits separate structured worker tasks\/DMs/);
  assert.match(orders, /ROOM permits new delegated work only through the scoped room contract/);
  assert.match(orders, /older DM tasks may finish/);
  assert.match(orders, /never changes your permanent brain role/);
});

test("brain orders respect server gates, non-adjacent transitions and Human locks", () => {
  const orders = standingOrders(brain);
  assert.match(orders, /continuously revalidates Jev at coordination boundaries/);
  assert.match(orders, /directly between non-adjacent modes/);
  assert.match(orders, /Do not bypass a 409 adaptive-routing rejection/);
  assert.match(orders, /pending de-escalation means finish\/reconcile already-running useful work/);
  assert.match(orders, /locks override automatic topology changes/);
  assert.match(orders, /recommendations remain advisory/);
});
