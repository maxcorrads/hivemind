#!/usr/bin/env node
import { integerArgument, MAX_WAIT_MS, sendInputSchema, validated } from "./shared/api-contract.ts";
import { sendOperation } from "./client/send-operation.ts";
import { resolve, dirname, basename, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DEFAULT_PORT, DEFAULT_WAIT_MS, MCP_HEARTBEAT_MS, MESSAGE_EVENT_TYPES, type MessageEventType } from "./shared/types.ts";
import { guessMime } from "./shared/mime.ts";
import {
  agentDownloadToFile,
  agentRequest,
  currentToken,
  hiveUrl,
  identitiesDir,
  loadIdentityByName,
  saveIdentity,
} from "./client/http.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import type { Agent, Channel, Message, WaitResult } from "./shared/types.ts";
import { parseJoinArgs } from "./shared/join-args.ts";

function help() {
  console.log(`hivemind — local hive for Human, brains, and workers

  hivemind serve [--port ${DEFAULT_PORT}]
  hivemind join --as worker junior|mid|senior [--focus …] [--project slug] [--resume Name]
  hivemind join --as worker --seniority junior|mid|senior [--project slug]
  hivemind join --as brain [--focus …] [--project slug] [--resume Name]
  hivemind wait [--timeout ${Math.round(DEFAULT_WAIT_MS / 1000)}] [--session UUID]
  hivemind ack DELIVERY_ID --session UUID
  hivemind send --channel NAME --body TEXT [--thread ID] [--file PATH] [--event-type progress|blocker|question|action_required]
  hivemind send --to NAME --body TEXT [--file PATH] [--request-id KEY]
  hivemind fetch --id ATT_ID [--out DIR]
  hivemind react --seq N --emoji 👍 [--remove]
  hivemind gc
  hivemind history --channel NAME [--thread ID] [--since N | --before N]
  hivemind expand --channel ID --ids MESSAGE_ID,MESSAGE_ID [--after SEQ]
  hivemind task assign --input FILE.json
  hivemind capabilities get --worker UUID | set --input FILE.json
  hivemind task suggest|routing-outcome|routing-override --id TASK_ID --input FILE.json
  hivemind task claim-preview --id TASK_ID --input FILE.json
  hivemind task handoffs [--before TASK_ID]
  hivemind task handoff --id TASK_ID
  hivemind task get --id TASK_ID
  hivemind task event --id TASK_ID --input FILE.json
  hivemind room get --channel NAME
  hivemind room history --channel NAME [--before REVISION]
  hivemind room event --channel NAME --input FILE.json
  hivemind subscriptions list
  hivemind subscriptions set --channel NAME [--thread ROOT_ID] --events progress,blocker
  hivemind subscriptions set --channel NAME [--thread ROOT_ID] --mute
  hivemind subscriptions reset --channel NAME [--thread ROOT_ID]
  hivemind search --q TEXT [--channel NAME] [--before N]
  hivemind agents
  hivemind channels
  hivemind whoami
  hivemind standing-orders
  hivemind clear-context --agent NAME
  hivemind invite --channel NAME --member NAME
  hivemind identities
  hivemind doctor
  hivemind leave
  hivemind mcp
  hivemind mcp-config
  hivemind plugins add /absolute/hivemind-plugin.json [--home /hive]
  hivemind plugins list | remove ID [--home /hive]
  hivemind plugins bind ID --project SLUG --config-home /existing/profile [--home /hive]

Environment: HIVEMIND_URL (default ${hiveUrl()})  HIVEMIND_TOKEN  HIVEMIND_HOME
`);
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function argRest(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const parts: string[] = [];
  for (let j = i + 1; j < args.length; j += 1) {
    const next = args[j]!;
    if (next.startsWith("--")) break;
    parts.push(next);
  }
  return parts.join(" ") || undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    help();
    return;
  }

  if (cmd === "serve") {
    const { startServer } = await import("./server/serve.ts");
    startServer({ port: integerArgument(String(arg(argv, "--port") ?? process.env.HIVEMIND_PORT ?? DEFAULT_PORT), 0, 65535) });
    return;
  }

  if (cmd === "mcp") {
    const { startMcp } = await import("./mcp/index.ts");
    await startMcp();
    return;
  }

  if (cmd === "plugins") {
    const { pluginsMain } = await import("./server/plugins.ts");
    await pluginsMain(argv.slice(1));
    return;
  }

  if (cmd === "mcp-config") {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const entry = resolve(root, "src/cli.ts");
    const config = {
      mcpServers: {
        hivemind: {
          command: "npx",
          args: ["tsx", entry, "mcp"],
          env: {
            HIVEMIND_URL: hiveUrl(),
          },
          tool_timeout_sec: 28800,
        },
      },
    };
    console.log(JSON.stringify(config, null, 2));
    console.error("This repo already has .cursor/mcp.json and .mcp.json. For Codex, paste the JSON above.");
    console.error(`Then in the agent: join as worker or brain. Server must be running at ${hiveUrl()}`);
    return;
  }

  if (cmd === "join") {
    const parsed = parseJoinArgs(argv);
    const as = parsed.role;
    const seniority = parsed.seniority;
    const focus = parsed.focus ?? arg(argv, "--focus") ?? null;
    const resume = parsed.resume;
    const token =
      parsed.token ??
      (resume ? loadIdentityByName(resume, parsed.project)?.token : undefined) ??
      (resume ? undefined : process.env.HIVEMIND_TOKEN);
    const result = await agentRequest<{
      agent: Agent;
      token: string;
      created: boolean;
      standingOrders?: string;
      describe: string;
    }>("POST", "/api/agent/join", {
      role: as,
      seniority: seniority ?? null,
      focus,
      resume,
      project: parsed.project,
      cwd: process.cwd(),
    }, token ?? null);
    saveIdentity({
      id: result.agent.id,
      name: result.agent.name,
      role: result.agent.role,
      seniority: result.agent.seniority,
      focus: result.agent.focus,
      token: result.token,
      project: result.agent.project,
    });
    console.log(`${result.created ? "Joined" : "Back"} as ${result.agent.name} · ${result.describe}`);
    console.log(`export HIVEMIND_TOKEN=${result.token}`);
    if (result.standingOrders) {
      console.log("");
      console.log(result.standingOrders);
    } else {
      console.log("orders unchanged — hivemind standing-orders");
    }
    return;
  }

  if (cmd === "doctor") {
    const res = await fetch(`${hiveUrl()}/api/health`);
    if (!res.ok) throw new Error(`server not healthy (${res.status})`);
    console.log(`ok ${hiveUrl()}`);
    return;
  }

  if (cmd === "identities") {
    const dir = identitiesDir();
    if (!existsSync(dir)) {
      console.log("no saved identities");
      return;
    }
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      console.log(file.replace(/\.json$/, ""));
    }
    return;
  }

  const token = arg(argv, "--token") ?? currentToken();
  if (!token) {
    throw new Error("No token. Join first, or set HIVEMIND_TOKEN.");
  }

  if (cmd === "wait") {
    const sessionId = arg(argv, "--session") ?? randomUUID();
    const timeout = integerArgument(String(arg(argv, "--timeout") ?? Math.round(DEFAULT_WAIT_MS / 1000)), 1, MAX_WAIT_MS / 1000) * 1000;
    await agentRequest("POST", "/api/agent/inbox/session", { sessionId }, token);
    const beat = setInterval(() => {
      agentRequest("POST", "/api/agent/ping", {}, token).catch(() => undefined);
    }, MCP_HEARTBEAT_MS);
    beat.unref();
    try {
      const result = await agentRequest<WaitResult>(
        "POST",
        "/api/agent/wait",
        { timeoutMs: timeout, compact: true, sessionId },
        token,
        timeout + 10_000,
      );
      console.log(JSON.stringify({ ...result, sessionId }, null, 2));
    } finally {
      clearInterval(beat);
    }
    return;
  }

  if (cmd === "ack") {
    const deliveryId = argv[1];
    const sessionId = arg(argv, "--session");
    if (!deliveryId || !sessionId) {
      throw new Error("ack DELIVERY_ID --session SESSION_ID (from the received wait result)");
    }
    console.log(JSON.stringify(await agentRequest(
      "POST", "/api/agent/inbox/ack", { sessionId, deliveryId }, token,
    )));
    return;
  }

  if (cmd === 'capabilities') {
    const file = arg(argv, '--input'), worker = arg(argv, '--worker');
    if (argv[1] === 'get' && worker) console.log(JSON.stringify(await agentRequest('GET', `/api/agent/workers/${encodeURIComponent(worker)}/capabilities`, undefined, token), null, 2));
    else if (argv[1] === 'set' && file) console.log(JSON.stringify(await agentRequest('POST', '/api/agent/capabilities', JSON.parse(readFileSync(file, 'utf8')), token), null, 2));
    else throw new Error('capabilities get --worker UUID | capabilities set --input FILE.json');
    return;
  }
  if (cmd === 'task') {
    const operation = argv[1];
    const id = arg(argv, '--id');
    if (operation === 'handoffs') {
      const before = arg(argv, '--before');
      console.log(JSON.stringify(await agentRequest('GET', `/api/agent/handoffs${before ? `?beforeTask=${encodeURIComponent(before)}` : ''}`, undefined, token), null, 2));
      return;
    }
    if (operation === 'handoff' && id) {
      console.log(JSON.stringify(await agentRequest('GET', `/api/agent/tasks/${encodeURIComponent(id)}/handoff`, undefined, token), null, 2));
      return;
    }
    if (operation === 'get' && id) {
      console.log(JSON.stringify(await agentRequest('GET', `/api/agent/tasks/${encodeURIComponent(id)}`, undefined, token), null, 2));
      return;
    }
    const file = arg(argv, '--input');
    if (!file || !['assign', 'event', 'claim-preview', 'suggest', 'routing-outcome', 'routing-override'].includes(operation) || (operation !== 'assign' && !id))
      throw new Error('task assign --input FILE.json | task get --id ID | task event --id ID --input FILE.json | task claim-preview --id ID --input FILE.json');
    const input = JSON.parse(readFileSync(file, 'utf8'));
    console.log(JSON.stringify(await agentRequest('POST', operation === 'assign' ? '/api/agent/tasks' :
      `/api/agent/tasks/${encodeURIComponent(id!)}/${operation === 'claim-preview' ? 'claim-preview' : operation === 'suggest' ? 'routing' : operation.startsWith('routing-') ? operation : 'events'}`, input, token), null, 2));
    return;
  }

  if (cmd === 'room') {
    const operation = argv[1], channel = arg(argv, '--channel');
    if (!channel || !['get', 'history', 'event'].includes(operation ?? '')) throw new Error('room get|history|event --channel NAME [--input FILE.json]');
    const endpoint = `/api/agent/channels/${encodeURIComponent(channel)}/room`;
    const file = arg(argv, '--input');
    if (operation === 'event' && !file) throw new Error('room event requires --input FILE.json');
    console.log(JSON.stringify(await agentRequest(operation === 'event' ? 'POST' : 'GET',
      endpoint + (operation === 'history' ? `/history?before=${encodeURIComponent(arg(argv, '--before') ?? String(Number.MAX_SAFE_INTEGER))}` : ''),
      operation === 'event' ? JSON.parse(readFileSync(file!, 'utf8')) : undefined, token), null, 2)); return;
  }
  if (cmd === 'subscriptions') {
    const operation = argv[1];
    if (operation === 'list') {
      console.log(JSON.stringify(await agentRequest('GET', '/api/agent/subscriptions', undefined, token), null, 2)); return;
    }
    if (operation !== 'set' && operation !== 'reset') throw new Error('subscriptions list|set|reset');
    const channel = arg(argv, '--channel'), threadId = arg(argv, '--thread');
    if (!channel) throw new Error('subscriptions requires --channel');
    const events = arg(argv, '--events');
    if (operation === 'set' && (!events && !argv.includes('--mute') || events && argv.includes('--mute')))
      throw new Error('Choose --events TYPE,TYPE or --mute');
    console.log(JSON.stringify(await agentRequest('POST', operation === 'set' ? '/api/agent/subscriptions' : '/api/agent/subscriptions/reset',
      { channel, threadId, ...(operation === 'set' ? { eventTypes: events ? events.split(',') : [] } : {}) }, token), null, 2)); return;
  }

  if (cmd === "send") {
    const eventType = arg(argv, "--event-type") as MessageEventType | undefined;
    const recipients = arg(argv, '--recipients')?.split(',');
    if (eventType !== undefined && !MESSAGE_EVENT_TYPES.includes(eventType)) throw new Error("Unknown --event-type");
    const body = argRest(argv, "--body") ?? "";
    const file = arg(argv, "--file");
    if (!body && !file) throw new Error("send --body TEXT  and/or  --file PATH");
    const thread = arg(argv, "--thread");
    const to = arg(argv, "--to");
    let channel = arg(argv, "--channel");
    validated(sendInputSchema, { body, threadId: thread, eventType, recipients, requestId: arg(argv, "--request-id") });
    if (to) {
      const dm = await agentRequest<{ channel: Channel }>("POST", "/api/agent/dms", { name: to }, token);
      channel = dm.channel.id;
    }
    if (!channel) throw new Error("send --channel NAME  or  --to NAME");
    const requestId = arg(argv, "--request-id") ?? randomUUID();
    const mime = file ? guessMime(file) : undefined;
    if (mime === "application/octet-stream") throw new Error("unsupported file type");
    console.error(`Send requestId: ${requestId}`);
    const result = await sendOperation({ channel, body, threadId: thread, eventType, recipients,
      ...(file ? { file: { path: resolvePath(file), name: basename(file), mime: mime! } } : {}) }, token, requestId);
    console.log(`sent ${result.id} seq ${result.seq}`);
    return;
  }

  if (cmd === "expand") {
    const channel = arg(argv, "--channel");
    const ids = arg(argv, "--ids");
    if (!channel || !ids) throw new Error("expand --channel ID --ids MESSAGE_ID,MESSAGE_ID [--after SEQ]");
    const after = arg(argv, "--after");
    console.log(JSON.stringify(await agentRequest("POST", "/api/agent/messages/expand",
      { channel, messageIds: ids.split(","), ...(after === undefined ? {} : { afterSeq: integerArgument(after) }) }, token), null, 2));
    return;
  }

  if (cmd === "fetch") {
    const id = arg(argv, "--id");
    if (!id) throw new Error("fetch --id ATT_ID");
    const out = arg(argv, "--out") ?? ".hivemind-inbox";
    mkdirSync(out, { recursive: true });
    const saved = await agentDownloadToFile(`/api/agent/files/${encodeURIComponent(id)}`, token, resolvePath(out), id.slice(0, 8));
    console.log(saved.path);
    return;
  }

  if (cmd === "react") {
    const seq = integerArgument(arg(argv, "--seq") ?? "", 1);
    const emoji = arg(argv, "--emoji");
    if (!seq || !emoji) throw new Error("react --seq N --emoji 👍");
    await agentRequest("POST", `/api/agent/messages/${seq}/reactions`, { emoji, present: !argv.includes("--remove") }, token);
    console.log(`reacted ${emoji} on ${seq}`);
    return;
  }

  if (cmd === "gc") {
    const { Hive } = await import("./server/hive.ts");
    const hive = new Hive();
    const result = hive.gcFiles();
    hive.db.close();
    console.log(`gc attachments=${result.attachments} blobs=${result.blobs}`);
    return;
  }

  if (cmd === "search") {
    const q = arg(argv, "--q") ?? arg(argv, "--query");
    if (!q) throw new Error("search --q TEXT");
    const channel = arg(argv, "--channel");
    const before = arg(argv, "--before");
    const limit = arg(argv, "--limit");
    const params = new URLSearchParams({ q });
    if (channel) params.set("channel", channel);
    if (before) params.set("beforeSeq", before);
    if (limit) params.set("limit", limit);
    const result = await agentRequest<{
      hits: Array<{ seq: number; channelName: string; channelType: string; authorName: string; body: string }>;
      hasMore: boolean;
    }>("GET", `/api/agent/search?${params}`, undefined, token);
    if (result.hits.length === 0) {
      console.log("no hits");
      return;
    }
    for (const hit of result.hits) {
      const room = hit.channelType === "dm" ? hit.channelName : `#${hit.channelName}`;
      console.log(`${hit.seq} ${room} ${hit.authorName}: ${hit.body}`);
    }
    if (result.hasMore) console.log("more: search --q … --before " + result.hits[result.hits.length - 1]!.seq);
    return;
  }

  if (cmd === "history") {
    const channel = arg(argv, "--channel");
    if (!channel) throw new Error("history --channel NAME");
    const thread = arg(argv, "--thread");
    const since = arg(argv, "--since");
    const before = arg(argv, "--before");
    if (since !== undefined && before !== undefined) throw new Error("Use --since or --before, not both");
    const query = new URLSearchParams({
      limit: arg(argv, "--limit") ?? "20",
      meta: arg(argv, "--meta") ?? "0",
    });
    if (thread) query.set("threadId", thread);
    if (since !== undefined) query.set("afterSeq", since);
    if (before !== undefined) query.set("beforeSeq", before);
    const result = await agentRequest<{
      messages: Message[];
      cursors?: { before?: number; after?: number };
    }>(
      "GET",
      `/api/agent/channels/${encodeURIComponent(channel)}/messages?${query}`,
      undefined,
      token,
    );
    for (const m of result.messages) {
      const when = new Date(m.createdAt).toISOString().slice(11, 19);
      console.log(`[${when}] ${m.authorName}: ${m.body}`);
    }
    if (result.cursors?.before !== undefined) {
      console.log(`older: history --channel ${channel} --before ${result.cursors.before}${thread ? ` --thread ${thread}` : ""}`);
    }
    if (result.cursors?.after !== undefined) {
      console.log(`newer: history --channel ${channel} --since ${result.cursors.after}${thread ? ` --thread ${thread}` : ""}`);
    }
    return;
  }

  if (cmd === "agents") {
    const result = await agentRequest<{ agents: Agent[] }>("GET", "/api/agent/agents", undefined, token);
    for (const a of result.agents) {
      const tag = a.online ? "online" : "offline";
      const extra = [a.role, a.seniority, a.focus].filter(Boolean).join(" ");
      console.log(`${tag.padEnd(8)} ${a.name.padEnd(12)} ${extra}`);
    }
    return;
  }

  if (cmd === "channels") {
    const result = await agentRequest<{ channels: Channel[] }>("GET", "/api/agent/channels", undefined, token);
    for (const ch of result.channels) {
      console.log(`${ch.type.padEnd(8)} ${ch.type === "dm" ? ch.name : "#" + ch.name}`);
    }
    return;
  }

  if (cmd === "whoami") {
    const result = await agentRequest<{ you: Agent; ordersRef?: string }>("GET", "/api/agent/me", undefined, token);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "standing-orders") {
    const result = await agentRequest<{ standingOrders: string }>("GET", "/api/agent/me?orders=1", undefined, token);
    console.log(result.standingOrders);
    return;
  }

  if (cmd === "clear-context") {
    const name = arg(argv, "--agent") ?? arg(argv, "--to");
    if (!name) throw new Error("clear-context --agent NAME");
    const result = await agentRequest<{ message: Message }>(
      "POST",
      "/api/agent/clear-context",
      { name },
      token,
    );
    console.log(`clear_context sent to ${name} (${result.message.id})`);
    return;
  }

  if (cmd === "invite") {
    const channel = arg(argv, "--channel");
    const member = arg(argv, "--member") ?? arg(argv, "--name");
    if (!channel || !member) throw new Error("invite --channel NAME --member NAME");
    const result = await agentRequest<{ channel: Channel }>(
      "POST",
      `/api/agent/channels/${encodeURIComponent(channel)}/invite`,
      { names: [member] },
      token,
    );
    console.log(`invited ${member} to ${result.channel.type === "dm" ? result.channel.name : "#" + result.channel.name}`);
    return;
  }

  if (cmd === "leave") {
    await agentRequest("POST", "/api/agent/leave", {}, token);
    console.log("offline");
    return;
  }

  help();
  throw new Error(`unknown command ${cmd}`);
}

main().catch((err) => {
  console.error(String(err.message || err));
  process.exit(1);
});
