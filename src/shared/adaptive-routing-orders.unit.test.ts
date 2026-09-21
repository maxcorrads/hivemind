import assert from "node:assert/strict";
import { test } from "node:test";
import { standingOrders } from "./standing-orders.ts";
import type { Agent } from "./types.ts";

const brain: Agent = {
  id: "brain-id",
  name: "Brain",
  role: "brain",
  seniority: null,
  focus: "coord",
  online: true,
  lastSeenAt: 1,
  createdAt: 1,
  projectId: "project-id",
  project: "chapter",
};

test("brain standing orders make active SINGLE routing directly executable without changing permanent role", () => {
  const orders = standingOrders(brain);
  assert.match(orders, /adaptive routing · SINGLE/);
  assert.match(orders, /execute it yourself in this brain session and do not assign\/delegate it/);
  assert.match(orders, /concrete evidence discovered during execution/);
  assert.match(orders, /ORCHESTRATED.*normal coordinator\/delegation behavior/);
  assert.match(orders, /do not change your permanent role/);
});
