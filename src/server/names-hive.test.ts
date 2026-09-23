import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { HUMAN_ID, HUMAN_NAME } from "../shared/types.ts";
import { Hive } from "./hive.ts";
import { AGENT_NAMES } from "./names.ts";
import { updateRows } from "./test-fixtures.ts";

function databaseFixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-names-"));
  const dbPath = path.join(dir, "hive.db");
  const handles = new Set<Hive>();
  t.after(() => {
    try {
      for (const hive of handles) hive.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return {
    open() {
      const hive = new Hive(dbPath);
      handles.add(hive);
      return hive;
    },
    close(hive: Hive) {
      hive.db.close();
      handles.delete(hive);
    },
  };
}

test("real joins reserve 500 identities across projects, offline state and restart", (t) => {
  const fixture = databaseFixture(t);
  let hive = fixture.open();
  const human = hive.getAgent(HUMAN_ID);
  const alpha = hive.createProject(human, { name: "Alpha", slug: "names-alpha" });
  const beta = hive.createProject(human, { name: "Beta", slug: "names-beta" });
  const joined: Array<ReturnType<Hive["join"]>> = [];
  const taken = new Set<string>();

  for (let index = 0; index < 500; index += 1) {
    const project = index % 4 < 2 ? alpha.slug : beta.slug;
    const result = index % 2 === 0
      ? hive.join({ role: "brain", project })
      : hive.join({ role: "worker", seniority: "mid", project });
    assert.equal(result.created, true);
    assert.ok(AGENT_NAMES.includes(result.agent.name), `premature fallback: ${result.agent.name}`);
    const key = result.agent.name.toLowerCase();
    assert.ok(!taken.has(key), `duplicate production identity: ${result.agent.name}`);
    taken.add(key);

    if (index === 0) {
      // Model an existing database with a differently-cased stored identity.
      updateRows(hive, "agents", { name: result.agent.name.toUpperCase() }, { id: result.agent.id });
    }
    joined.push({ ...result, agent: hive.getAgent(result.agent.id) });
    hive.setOffline(result.agent.id);
  }

  assert.deepEqual(taken, new Set(AGENT_NAMES.map((name) => name.toLowerCase())));
  const first = joined[0]!;
  const other = joined[2]!;
  const visible = hive.listAgents(first.agent);
  assert.equal(visible.length, 251);
  assert.ok(visible.every((agent) => agent.id === HUMAN_ID || agent.projectId === alpha.id));
  assert.ok(!visible.some((agent) => agent.id === other.agent.id));
  assert.equal(hive.getAgent(HUMAN_ID).name, HUMAN_NAME);
  assert.equal(hive.getAgent(HUMAN_ID).role, "human");

  assert.throws(() => hive.join({ role: "brain", token: first.token, project: beta.slug }), /project cannot change/);
  assert.throws(
    () => hive.join({ role: "brain", token: first.token, resumeName: other.agent.name }),
    /not /,
  );
  assert.equal(hive.listAgents().length, 501);

  const numberedBrain = hive.join({ role: "brain", project: alpha.slug });
  const numberedWorker = hive.join({ role: "worker", seniority: "mid", project: beta.slug });
  assert.equal(numberedBrain.agent.name, "Brain1");
  assert.equal(numberedWorker.agent.name, "Worker1");
  hive.setOffline(numberedBrain.agent.id);
  hive.setOffline(numberedWorker.agent.id);

  fixture.close(hive);
  hive = fixture.open();
  for (const original of joined) {
    assert.equal(hive.getAgent(original.agent.id).name, original.agent.name, "restart renamed an identity");
  }
  const resumed = hive.join({
    role: "brain", token: first.token, resumeName: first.agent.name.toLowerCase(), project: alpha.slug,
  });
  assert.equal(resumed.created, false);
  assert.equal(resumed.agent.id, first.agent.id);
  assert.equal(resumed.agent.name, first.agent.name);
  const resumedNumber = hive.join({
    role: "worker", seniority: "mid", token: numberedWorker.token, resumeName: "WORKER1", project: beta.slug,
  });
  assert.equal(resumedNumber.created, false);
  assert.equal(resumedNumber.agent.id, numberedWorker.agent.id);
  assert.equal(hive.listAgents().length, 503);
  assert.equal(hive.join({ role: "brain", project: alpha.slug }).agent.name, "Brain2");
  assert.equal(hive.join({ role: "worker", seniority: "mid", project: beta.slug }).agent.name, "Worker2");
});

test("interleaved joins on two database handles reserve names in production", (t) => {
  const fixture = databaseFixture(t);
  const handles = [fixture.open(), fixture.open()];
  const taken = new Set<string>();
  for (let index = 0; index < 500; index += 1) {
    const result = handles[index % 2]!.join({ role: "brain" });
    assert.ok(AGENT_NAMES.includes(result.agent.name));
    const key = result.agent.name.toLowerCase();
    assert.ok(!taken.has(key), `another database handle reused ${result.agent.name}`);
    taken.add(key);
  }
  assert.equal(taken.size, 500);
  assert.equal(handles[0]!.join({ role: "brain" }).agent.name, "Brain1");
  assert.equal(handles[1]!.join({ role: "brain" }).agent.name, "Brain2");
});
