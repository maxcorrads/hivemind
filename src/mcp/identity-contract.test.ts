import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hive } from "../server/hive.ts";
import { startServer } from "../server/serve.ts";
import type { WaitResult } from "../shared/types.ts";
import { childEnv } from "../test-support/child-process.ts";

test("real concurrent/repeated MCP joins reuse the active identity without exposing its token or resetting delivery", { timeout: 20_000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-join-session-"));
  const hive = new Hive(path.join(dir, "hive.db")), service = startServer({ hive, port: 0, telegram: false });
  const client = new Client({ name: "join-fixture", version: "0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", path.join(root,"node_modules/tsx/dist/loader.mjs"), path.join(root,"src/cli.ts"), "mcp"], cwd: dir,
    env: childEnv({ PATH: process.env.PATH ?? "", HIVEMIND_HOME: path.join(dir,"identity"), HIVEMIND_URL: `http://127.0.0.1:${await service.ready}`, HIVEMIND_TOKEN: "" }), stderr: "pipe" });
  t.after(async () => { await client.close(); await transport.close(); await service.shutdown(); hive.db.close(); rmSync(dir,{ recursive:true,force:true }); });
  await client.connect(transport);
  const call = async <T>(name: string, args: Record<string,unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError,true,JSON.stringify(result));
    const text = (result.content as Array<{type:string;text:string}>)[0]!.text;
    assert.doesNotMatch(text, /hm_[a-f0-9]{48}/, "model result leaked a token");
    return JSON.parse(text) as T;
  };
  const [a,b] = await Promise.all([call<{ name:string;created:boolean }>("join",{ role:"brain" }), call<{ name:string;created:boolean }>("join",{ role:"brain" })]);
  assert.equal(a.name,b.name); assert.equal([a,b].filter(x=>x.created).length,1);
  assert.equal(hive.listAgents().filter(a=>a.role==="brain").length,1);
  const agent = hive.getAgentByName(a.name)!, human = hive.getAgent("human");
  const dm = hive.openDm(human,agent.name); hive.postMessage(human,{channel:dm.id,body:"do not reset this delivery session"});
  const mail = await call<WaitResult>("wait"); const session = hive.inbox.currentSession(agent.id);
  await call("join",{role:"brain",resume:agent.name});
  assert.equal(hive.inbox.currentSession(agent.id),session);
  await call("ack_delivery",{deliveryId:mail.delivery!.id});
  const bad = await client.callTool({name:"join",arguments:{role:"worker",seniority:"mid"}});
  assert.equal(bad.isError,true); assert.equal(hive.listAgents().filter(a=>a.role!=="human").length,1);
});
