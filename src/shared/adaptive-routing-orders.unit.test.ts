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
  assert.match(orders, /SINGLE: do the work yourself in this session; do not delegate/);
  assert.match(orders, /BRAIN\+1: at most one active worker/);
  assert.match(orders, /MULTI-DM: separate structured tasks\/DMs within the worker budget/);
  assert.match(orders, /ROOM: new delegated work only through the scoped room contract/);
  assert.match(orders, /Older DM tasks may finish/);
  assert.match(orders, /never changes your permanent brain role/);
  assert.match(orders, /Jev routes every Human message addressed to you, in any channel or thread; workers never go through Jev/);
  assert.doesNotMatch(orders, /do not implement/i);
});

test("brain orders respect server gates, non-adjacent transitions and Human locks", () => {
  const orders = standingOrders(brain);
  assert.match(orders, /revalidates Jev at coordination boundaries/);
  assert.match(orders, /even between non-adjacent modes/);
  assert.match(orders, /Never bypass a 409 adaptive-routing rejection/);
  assert.match(orders, /pending de-escalation means: finish or reconcile useful running work/);
  assert.match(orders, /locks override automatic changes/);
  assert.match(orders, /recommendations stay advisory/);
});
