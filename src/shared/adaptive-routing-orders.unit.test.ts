import assert from "node:assert/strict";
import { test } from "node:test";
import { standingOrders } from "./standing-orders.ts";
import type { Agent } from "./types.ts";

const brain: Agent = {
  id: "brain-id", name: "Brain", role: "brain", seniority: null,
  focus: "coord", online: true, lastSeenAt: 1, createdAt: 1,
  projectId: "project-id", project: "chapter",
};
const worker: Agent = { ...brain, id: "worker-id", name: "Forge", role: "worker", seniority: "senior" };

test("brain orders present Jev as advice returned with every action, overridden by Human (#211)", () => {
  const orders = standingOrders(brain);
  assert.match(orders, /## Jev advice/);
  assert.match(orders, /send, attach, assign_task, task_event, room_event, set_thread_status, wait\): the response carries its suggestion as jevAdvice/);
  assert.match(orders, /jevAdvice is advisory only: decide the plan yourself from the task/);
  assert.match(orders, /Human instructions always override it/);
  assert.match(orders, /SINGLE, BRAIN\+1, MULTI-DM and ROOM are suggestions, not enforced modes/);
  assert.doesNotMatch(orders, /do not implement/i);
});

test("no order describes enforcement that no longer exists", () => {
  for (const orders of [standingOrders(brain), standingOrders(worker)]) {
    assert.doesNotMatch(orders, /\[Hivemind adaptive topology/);
    assert.doesNotMatch(orders, /pass it on every coordination action|executionId: pass/);
    assert.doesNotMatch(orders, /409 adaptive-routing|de-escalation|Human task\/conversation locks|worker budget\./);
  }
  assert.doesNotMatch(standingOrders(worker), /jevAdvice/);
});
