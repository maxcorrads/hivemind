import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { Hive } from "../src/server/hive.ts";
import { createApp } from "../src/server/app.ts";
import { registerPlugin } from "../src/server/plugins.ts";
import { ProjectPlugins } from "./ProjectPlugins.tsx";
import type { LaunchContext } from "../src/shared/launch-prompt.ts";
import { api } from "./api.ts";
import { App } from "./App.tsx";
import { LaunchSheet } from "./LaunchSheet.tsx";
import { countRows, hasRow, listRows, seedMessages } from "../src/server/test-fixtures.ts";

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window, document: window.document, location: window.location,
  localStorage: window.localStorage, HTMLElement: window.HTMLElement,
  HTMLSelectElement: window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
const { createRoot } = await import("react-dom/client");
after(() => window.happyDOM.close());

class SocketFixture {
  static instances: SocketFixture[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { SocketFixture.instances.push(this); }
  close() { this.closed = true; this.onclose?.(); }
  emit(type: string, payload: unknown) { this.onmessage?.({ data: JSON.stringify({ type, payload }) }); }
}

async function fixture(t: TestContext) {
  window.localStorage.clear(); window.sessionStorage.clear(); SocketFixture.instances = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), "extensibility-workflow-"));
  const hive = new Hive(path.join(dir, "hive.db")), human = hive.identity.getAgent("human");
  const a = hive.projects.listProjects()[0]!, b = hive.projects.createProject(human, { slug: "other", name: "Other" });
  const brainA = hive.identity.join({ role: "brain", project: a.slug }).agent;
  const worker = hive.identity.join({ role: "worker", seniority: "senior", project: a.slug }).agent;
  const brainB = hive.identity.join({ role: "brain", project: b.slug }).agent;
  const botA = hive.bots.createBot(human, a.id, { name: "FeedA" });
  const botB = hive.bots.createBot(human, b.id, { name: "FeedB" });
  const channel = hive.channels.createChannel(human, { project: a.slug, name: "observations", type: "private" });
  hive.channels.invite(human, channel.id, [botA.bot.name]);
  window.happyDOM.setURL(`http://localhost/#/c/${channel.id}`);
  const app = createApp(hive), requests: string[] = [], copies: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    // Mounted component fixture uses the internal Hono router, not a network
    // adapter. Model only bootstrap here; real cookies/transport rejection and
    // exactly-once mutations are exercised in extensibility-session.test.ts.
    if (url === "/api/ui/session") return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    requests.push(url); return app.request(url, init);
  });
  t.mock.method(window.navigator.clipboard, "writeText", async (text: string) => { copies.push(text); });
  const nativeSocket = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: SocketFixture });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => {
    try { await act(async () => root.unmount()); }
    finally {
      host.remove(); hive.db.close(); rmSync(dir, { recursive: true, force: true });
      Object.assign(globalThis, { WebSocket: nativeSocket });
    }
    assert.ok(SocketFixture.instances.every(socket => socket.closed), "all UI sockets must close on unmount");
  });
  const button = (label: string, scope: ParentNode = host) => {
    const found = Array.from(scope.querySelectorAll("button")).find(b => b.textContent?.trim() === label);
    assert.ok(found, `Missing button ${label}`); return found;
  };
  const click = async (element: HTMLElement) => { await act(async () => element.click()); };
  const change = async (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) => {
    await act(async () => {
      const prototype = element.tagName === "SELECT" ? window.HTMLSelectElement.prototype : element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }) as unknown as Event);
    });
  };
  const field = (label: string) => {
    const found = Array.from(host.querySelectorAll("label")).find(el => el.textContent?.trim().startsWith(label));
    const control = found?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea");
    assert.ok(control, `Missing field ${label}`); return control;
  };
  let closed = 0;
  const onClose = () => { closed++; };
  const renderLaunch = async (projects = [a, b], defaultProject = a.slug) => {
    await act(async () => root.render(createElement(LaunchSheet, {
      projects, agents: hive.identity.listAgents(human), defaultProject, onClose,
    })));
  };
  const context = (slug: string): LaunchContext => {
    const project = [a, b].find(p => p.slug === slug)!;
    return { project: { id: project.id, slug }, plugins: [{ id: "feed", name: `Feed for ${slug}` }],
      pluginInstructions: `ONLY_PROJECT_${slug.toUpperCase()}_TOOLS`,
      hivemindMcp: { command: "node", args: ["/fixture/hive.ts", "mcp"], env: { HIVEMIND_URL: "http://127.0.0.1:7421" } } };
  };
  return { home: dir, hive, human, a, b, brainA, brainB, worker, botA, botB, channel, host, root,
    requests, copies, button, click, change, field, renderLaunch, context, closed: () => closed };
}

test("App routes project bot creation, one-time credentials and plugin settings through the real scoped API", async t => {
  const f = await fixture(t);
  await act(async () => f.root.render(createElement(App)));
  const socket = SocketFixture.instances[0]!;
  await act(async () => { socket.onopen?.(); });
  assert.ok(f.host.querySelector('[title="live"]'));
  await f.click(f.host.querySelector<HTMLButtonElement>(`[aria-label="Create bot in ${f.a.name}"]`)!);
  let dialog = f.host.querySelector('[aria-label="Create project bot"]')!;
  await f.change(dialog.querySelector("input")!, "CreatedFeed");
  await f.click(f.button("Create bot", dialog));
  const created = f.hive.identity.listAgents(f.human).find(agent => agent.name === "CreatedFeed")!;
  assert.equal(created.project, f.a.slug);
  const secret = dialog.querySelector<HTMLInputElement>('[aria-label="Bot token"]')!.value;
  assert.equal(f.hive.identity.agentByToken(secret).id, created.id);
  assert.equal(f.hive.identity.agentByToken(f.botB.token).id, f.botB.bot.id);
  await f.click(f.button("Close", dialog));
  assert.equal(f.host.querySelector('[aria-label="Create project bot"]'), null);
  await f.click(f.host.querySelector<HTMLButtonElement>('[aria-label="Actions for CreatedFeed"]')!);
  await f.click(f.host.querySelector<HTMLButtonElement>('[aria-label="Manage credentials for CreatedFeed"]')!);
  dialog = f.host.querySelector('[aria-label="Manage bot credentials"]')!;
  assert.match(dialog.textContent!, /revision 1/);
  assert.equal(dialog.querySelector('[aria-label="New bot token"]'), null);
  await f.click(f.button("Close", dialog));
  await f.click(f.host.querySelector<HTMLButtonElement>('[title="Project settings"]')!);
  await f.click(f.button("Plugins…"));
  assert.match(f.host.textContent!, /No installed plugins/);
  assert.ok(f.requests.includes(`/api/ui/projects/${f.a.slug}/plugins`));
  assert.ok(!f.requests.includes(`/api/ui/projects/${f.b.slug}/plugins`));
  await f.click(f.button("Close")); await f.click(f.button("Cancel"));
  await f.click(f.host.querySelector<HTMLButtonElement>('[title="Dark"]')!);
  assert.equal(window.localStorage.getItem("hivemind-theme"), "dark");
  for (let i = 0; i < window.localStorage.length; i++) {
    assert.ok(!window.localStorage.getItem(window.localStorage.key(i)!)!.includes(secret));
  }
  await f.click(f.host.querySelector<HTMLButtonElement>('[title="Launch agent"]')!);
  assert.match(f.host.textContent!, /Workers|Launch/);
  await f.click(f.button("Close"));
});

test("App renders a bot observation once under duplicate delivery and keeps its source intact", async t => {
  const f = await fixture(t);
  await act(async () => f.root.render(createElement(App)));
  const message = f.hive.bots.postBotMessage(f.botA.bot, f.channel.id, {
    eventId: "ui-dedup", body: "Unique observation from FeedA", origin: { label: "External feed", url: "https://example.com/event" },
  }).message;
  await act(async () => {
    SocketFixture.instances[0]!.emit("message", message);
    SocketFixture.instances[0]!.emit("message", message);
  });
  const bodies = Array.from(f.host.querySelectorAll(".msg-b"));
  assert.equal(bodies.filter(el => el.textContent?.includes(message.body)).length, 1);
  assert.ok(f.host.querySelector('a[href="https://example.com/event"]'));
  assert.equal(countRows(f.hive, "bot_events"), 1);
  await act(async () => { SocketFixture.instances[0]!.emit("queued", { agentId: f.brainA.id, n: 3 }); });
  assert.ok(f.host.querySelector('[title="3 waiting"]'));
});

test("mounted launch switches project tools safely, excludes bot seats and only copies scoped commands", async t => {
  const f = await fixture(t);
  t.mock.method(api, "launchContext", async (slug: string) => f.context(slug));
  await f.renderLaunch();
  assert.match(f.host.querySelector("pre")!.textContent!, new RegExp(f.context(f.a.slug).pluginInstructions));
  await f.click(f.field("worker"));
  assert.doesNotMatch(f.host.querySelector("pre")!.textContent!, /ONLY_PROJECT/);
  assert.match(f.host.textContent!, /Workers do not need project plugin instructions/);
  await f.click(f.field("junior"));
  assert.match(f.host.querySelector("pre")!.textContent!, /junior/);
  await f.click(f.field("brain"));
  await f.change(f.field("Project"), f.b.slug);
  assert.match(f.host.querySelector("pre")!.textContent!, /ONLY_PROJECT_OTHER_TOOLS/);
  assert.doesNotMatch(f.host.querySelector("pre")!.textContent!, new RegExp(f.context(f.a.slug).pluginInstructions));
  await f.change(f.field("CLI flags"), "; untrusted-command");
  assert.ok(f.button("Copy command").disabled);
  assert.match(f.host.textContent!, /metacharacters/);
  await f.change(f.field("CLI flags"), "");
  await f.click(f.field("Resume same employees"));
  assert.deepEqual(Array.from(f.host.querySelectorAll(".launch-card strong")).map(el => el.textContent), [f.brainB.name]);
  await f.click(f.field("all hives"));
  const cards = Array.from(f.host.querySelectorAll(".launch-card"));
  assert.equal(cards.length, 3);
  for (const card of cards) {
    const name = card.querySelector("strong")!.textContent;
    const prompt = card.querySelector("pre")!.textContent!;
    if (name === f.worker.name) assert.doesNotMatch(prompt, /ONLY_PROJECT/);
    else {
      const slug = name === f.brainA.name ? f.a.slug : f.b.slug;
      assert.match(prompt, new RegExp(f.context(slug).pluginInstructions));
      assert.doesNotMatch(prompt, new RegExp(f.context(slug === f.a.slug ? f.b.slug : f.a.slug).pluginInstructions));
    }
  }
  await f.click(f.button("Copy all"));
  assert.equal(f.copies.length, 1);
  assert.match(f.copies[0]!, /#!\/bin\/zsh/);
  assert.doesNotMatch(f.copies[0]!, /FeedA|FeedB/);
  assert.ok(!f.copies[0]!.includes(f.botA.token));
  assert.ok(!window.localStorage.getItem("hivemind-launch")!.includes("ONLY_PROJECT"));
  await act(async () => {
    f.field("Project").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  });
  assert.equal(f.closed(), 0);
  await act(async () => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" })); });
  assert.equal(f.closed(), 1);
});

test("launch discards obsolete project context responses and disables copying when the current connection fails", async t => {
  const f = await fixture(t);
  window.localStorage.setItem("hivemind-launch", "not valid JSON");
  let resolveOld!: (context: LaunchContext) => void;
  const obsolete = new Promise<LaunchContext>(resolve => { resolveOld = resolve; });
  t.mock.method(api, "launchContext", (slug: string) => slug === f.a.slug ? obsolete : Promise.reject(new Error("Connection unavailable")));
  await f.renderLaunch([f.a]);
  assert.ok(f.button("Copy command").disabled);
  await f.renderLaunch([f.b], f.b.slug);
  await act(async () => { resolveOld(f.context(f.a.slug)); await obsolete; });
  assert.match(f.host.textContent!, /Connection unavailable/);
  assert.ok(f.button("Copy command").disabled);
  assert.equal(f.host.querySelector("pre"), null);
  assert.doesNotMatch(f.host.textContent!, /ONLY_PROJECT/);
  assert.equal(f.copies.length, 0);
});

test("private-channel UI grants a bot access only after an explicit same-project invitation", async t => {
  const f = await fixture(t);
  await act(async () => f.root.render(createElement(App)));
  await f.click(f.host.querySelector<HTMLButtonElement>('[title="New channel"]')!);
  await f.change(f.field("Name"), "bot-private");
  await f.change(f.field("Topic"), "Selected observations");
  await f.change(f.field("Visibility"), "private");
  const form = f.host.querySelector(".modal form")!;
  assert.doesNotMatch(form.textContent!, new RegExp(f.botB.bot.name));
  await f.click(f.field(f.worker.name));
  await f.click(f.field(f.worker.name));
  await f.click(f.field(f.worker.name));
  await f.click(f.button("Create", form));
  const channel = f.hive.channels.listChannels(f.human).find(ch => ch.name === "bot-private")!;
  assert.equal(channel.project, f.a.slug);
  assert.ok(channel.memberIds.includes(f.worker.id));
  const input = { eventId: "invite-required", body: "New channel observation" };
  assert.throws(() => f.hive.bots.postBotMessage(f.botA.bot, channel.id, input), /channel|Channel|access/);
  await f.click(f.button("Invite"));
  const invite = f.host.querySelector(".modal form")!;
  assert.doesNotMatch(invite.textContent!, new RegExp(f.botB.bot.name));
  await f.click(f.field(f.botA.bot.name));
  await f.click(f.field(f.botA.bot.name));
  await f.click(f.field(f.botA.bot.name));
  await f.click(f.button("Invite", invite));
  assert.ok(f.hive.channels.listChannels(f.human).find(ch => ch.id === channel.id)!.memberIds.includes(f.botA.bot.id));
  assert.equal(f.hive.bots.postBotMessage(f.botA.bot, channel.id, input).duplicate, false);
  assert.throws(() => f.hive.bots.postBotMessage(f.botB.bot, channel.id, input), /channel|Channel|access/);
});

test("brain DMs have no routing selector and post only the Human message (#211)", async t => {
  const f = await fixture(t);
  await act(async () => f.root.render(createElement(App)));
  const brainButton = Array.from(f.host.querySelectorAll<HTMLButtonElement>(".person-main"))
    .find(button => button.querySelector(".pn")?.textContent === f.brainA.name);
  assert.ok(brainButton);
  await f.click(brainButton);
  assert.equal(f.host.querySelector('[aria-label="Execution mode"], [aria-label="Routing lock scope"], .composer-routing'), null,
    "the composer has no mode or lock selector");
  const composer = f.host.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  await f.change(composer, "Handle this directly");
  await f.click(f.button("Send"));
  assert.match(f.host.textContent!, /Handle this directly/);
  assert.doesNotMatch(f.host.textContent!, /Hivemind adaptive topology/);
  const sent = listRows(f.hive, "messages", { where: { author_id: "human", channel_id: f.hive.channels.findDm(f.human.id, f.brainA.id)!.id },
    columns: "body", orderBy: "seq" }) as Array<{ body: string }>;
  assert.deepEqual(sent.map(row => row.body), ["Handle this directly"]);
});

test("observation threads support Human replies and reactions without granting bot workflow authority", async t => {
  const f = await fixture(t);
  const message = f.hive.bots.postBotMessage(f.botA.bot, f.channel.id, {
    eventId: "discussion", body: "Review this observation", origin: { url: "https://example.com/review" },
  }).message;
  await act(async () => f.root.render(createElement(App)));
  await f.click(f.button("Copy link"));
  assert.deepEqual(f.copies, ["https://example.com/review"]);
  await f.click(f.host.querySelector<HTMLButtonElement>(".react-pick button")!);
  assert.match(f.host.querySelector(".reacts")!.textContent!, /1/);
  await f.click(f.host.querySelector<HTMLButtonElement>('button[aria-label="Reply in thread"]')!);
  const thread = f.host.querySelector<HTMLElement>("aside.thread")!;
  await f.change(thread.querySelector("textarea")!, "Human follow-up");
  await f.click(f.button("Send", thread));
  assert.match(thread.textContent!, /Human follow-up/);
  await f.click([...thread.querySelectorAll<HTMLButtonElement>(".status-menu [role=menuitemradio]")]
    .find(item => item.textContent === "In progress")!);
  assert.equal(thread.querySelector("[data-thread-status]")!.getAttribute("data-thread-status"), "in_progress");
  await f.click(thread.querySelector<HTMLButtonElement>(".react-pick button")!);
  assert.ok(f.requests.includes(`/api/ui/threads/${message.id}/status`));
  await f.click(thread.querySelector<HTMLButtonElement>('button[aria-label="Close thread"]')!);
  assert.equal(f.host.querySelector("aside.thread"), null);
  const composer = f.host.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  await f.change(composer, "@Feed");
  assert.equal(f.host.querySelector(".hints"), null, "bots cannot be assigned as workers by autocomplete");
  await f.change(composer, "@" + f.brainA.name.slice(0, 2));
  assert.ok(f.host.querySelector(".hints"));
  await f.click(f.host.querySelector<HTMLButtonElement>(".hints button")!);
  assert.match(composer.value, new RegExp("@" + f.brainA.name));
  await f.change(composer, "Human channel update");
  await act(async () => {
    composer.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  });
  assert.equal(composer.value, "");
  assert.ok(hasRow(f.hive, "messages", { body: "Human channel update", author_id: "human" }));
});

test("mounted plugin configuration persists typed fields privately and availability remains project-scoped", async t => {
  const f = await fixture(t), pkg = path.join(f.home, "fixture-plugin");
  mkdirSync(pkg);
  writeFileSync(path.join(pkg, "hivemind-plugin.json"), JSON.stringify({
    version: 1, id: "typed-feed", name: "Typed Feed", instructions: "TOOLS.md", settings: "settings.json", command: "tool",
  }));
  writeFileSync(path.join(pkg, "TOOLS.md"), "Use {{command}} only when asked.");
  writeFileSync(path.join(pkg, "settings.json"), JSON.stringify({ version: 1, fields: [
    { key: "host", label: "Host", type: "string", required: true },
    { key: "count", label: "Count", type: "integer", minimum: 1 },
    { key: "mode", label: "Mode", type: "string", choices: ["new", "all"] },
    { key: "tags", label: "Tags", type: "strings" },
    { key: "active", label: "Active", type: "boolean" },
  ] }));
  writeFileSync(path.join(pkg, "tool"), `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const request=JSON.parse(input);fs.writeFileSync(path.join(process.argv[4],'config.json'),JSON.stringify(request.config),{mode:0o600});console.log(JSON.stringify({configured:true}));});\n`, { mode: 0o700 });
  registerPlugin(f.home, path.join(pkg, "hivemind-plugin.json"));
  await act(async () => f.root.render(createElement(ProjectPlugins, { project: f.a, onClose: () => {} })));
  await f.click(f.button("Configure"));
  await f.change(f.field("Host"), "example.invalid");
  await f.change(f.field("Count"), "2");
  await f.change(f.field("Count"), "");
  await f.change(f.field("Count"), "3");
  await f.change(f.field("Mode"), "all");
  await f.change(f.field("Tags"), " alpha \n\nalpha");
  await f.click(f.field("Active"));
  await f.click(f.field("Available to this project"));
  // Wait on the real API operation, not a timer: React act alone does not wait for a child process.
  let saved!: Promise<{ plugin: Awaited<ReturnType<typeof api.projectPlugins>>["plugins"][number] }>;
  const save = api.saveProjectPlugin;
  t.mock.method(api, "saveProjectPlugin", (...args: Parameters<typeof save>) => { saved = save(...args); return saved; });
  await act(async () => { f.button("Save locally").click(); await saved; });
  const view = (await api.projectPlugins(f.a.slug)).plugins[0]!;
  assert.equal(view.enabled, true);
  assert.deepEqual(view.values, { host: "example.invalid", count: 3, mode: "all", tags: [" alpha ", "", "alpha"], active: true });
  assert.deepEqual(JSON.parse(readFileSync(path.join(view.home, "config.json"), "utf8")), { ...view.values, hiveUrl: "http://127.0.0.1" });
  assert.equal((await api.projectPlugins(f.b.slug)).plugins[0]!.configured, false);
  await f.click(f.button("Disable for project"));
  assert.equal((await api.projectPlugins(f.a.slug)).plugins[0]!.enabled, false);
  await f.click(f.button("Enable for project"));
  assert.equal((await api.projectPlugins(f.a.slug)).plugins[0]!.enabled, true);
  await f.click(f.button("Configure"));
  assert.equal(f.field("Tags").value, " alpha \n\nalpha");
  await f.click(f.button("Hide settings"));
  await f.click(f.button("Reload saved"));
  assert.match(f.host.textContent!, /Available to brain/);
});

test("launch preferences and per-seat overrides survive remount without persisting project tool context", async t => {
  const f = await fixture(t);
  window.localStorage.setItem("hivemind-launch", JSON.stringify({
    softwareUsed: [" codex ", "codex", "claude"], role: "invalid", seniority: "invalid", tunes: { gone: null },
  }));
  t.mock.method(api, "launchContext", async (slug: string) => f.context(slug));
  await f.renderLaunch();
  await f.change(f.field("Software"), "claude");
  const model = f.field("Model") as HTMLSelectElement;
  const chosen = Array.from(model.options).find(o => o.value)!;
  await f.change(model, chosen.value);
  await f.change(f.field("Workspace path"), "/tmp/selected-project");
  await f.change(f.field("Focus"), "review");
  for (const label of ["cd into", "pass project", "treat hive mail"]) { await f.click(f.field(label)); }
  assert.ok(f.button("Copy command").disabled, "brain tools require explicit project binding");
  await f.click(f.field("pass project"));
  assert.ok(!f.button("Copy command").disabled, f.host.textContent!);
  await f.click(f.button("Copy command"));
  assert.match(f.copies[0]!, /--mcp-config/);
  assert.doesNotMatch(f.copies[0]!, /cd '\/tmp\/selected-project'/);
  await f.click(f.field("Resume same employees"));
  const card = f.host.querySelector(".launch-card")!;
  const seatModel = card.querySelector("select")!;
  const override = Array.from(seatModel.options).find(o => o.value)!;
  await f.change(seatModel, override.value);
  await f.click(f.button("Copy", card));
  const saved = JSON.parse(window.localStorage.getItem("hivemind-launch")!);
  assert.equal(saved.software, "claude");
  assert.equal(saved.resume, true);
  assert.ok(Object.keys(saved.tunes).length > 0);
  assert.ok(!JSON.stringify(saved).includes("ONLY_PROJECT"));
  await act(async () => f.root.render(null));
  await f.renderLaunch();
  assert.equal(f.field("Software").value, "claude");
  assert.equal(f.host.querySelectorAll(".launch-card").length, 2);
});

for (const threaded of [false, true]) {
  test(`App preserves loaded history, DOM selection and unseen receipts under live arrivals (thread=${threaded})`, async t => {
    const f = await fixture(t);
    f.hive.channels.invite(f.human, f.channel.id, [f.brainA.name]);
    const first = f.hive.messages.postMessage(f.brainA, { channel: f.channel.id, body: "History body 1" });
    if (threaded) f.hive.messages.postMessage(f.brainA, { channel: f.channel.id, threadId: first.id, body: "History body 2" });
    seedMessages(f.hive, Array.from({ length: 580 - (threaded ? 3 : 2) + 1 }, (_, n) => (threaded ? 3 : 2) + n).map(i => ({
      id: `history-${i}`, channelId: f.channel.id, threadId: threaded ? first.id : null, authorId: f.brainA.id,
      body: `History body ${i}`, createdAt: 1 })));
    if (threaded) window.happyDOM.setURL(`http://localhost/#/c/${f.channel.id}/t/${first.id}`);
    const receipts: number[][] = [];
    const mark = f.hive.reads.markMessagesRead.bind(f.hive.reads);
    t.mock.method(f.hive.reads, "markMessagesRead", (...args: Parameters<typeof mark>) => {
      receipts.push(args[2]); return mark(...args);
    });
    await act(async () => f.root.render(createElement(App)));
    const scope = threaded ? f.host.querySelector<HTMLElement>("aside.thread")! : f.host.querySelector<HTMLElement>("main.desk")!;
    assert.ok(scope);
    const label = threaded ? "Load more replies" : "Load older";
    for (let page = 0; scope.querySelectorAll(".msg-b").length < 580; page++) {
      assert.ok(page < 40, "history pagination must progress");
      await f.click(f.button(label, scope));
    }
    const stream = scope.querySelector<HTMLElement>(".stream")!;
    const anchor = Array.from(stream.querySelectorAll<HTMLElement>(".msg-b"))
      .find((element) => element.textContent === "History body 40")!;
    assert.ok(anchor);
    Object.defineProperties(stream, {
      scrollHeight: { configurable: true, value: 4000 },
      clientHeight: { configurable: true, value: 400 },
    });
    stream.scrollTop = 300;
    await act(async () => stream.dispatchEvent(new window.Event("scroll") as unknown as Event));
    const displayedCount = stream.querySelectorAll(".msg-b").length;
    const selection = document.getSelection()!;
    const range = document.createRange(); range.selectNodeContents(anchor);
    selection.removeAllRanges(); selection.addRange(range);
    const selected = selection.toString();
    assert.equal(selected, "History body 40");
    const incoming = f.hive.messages.postMessage(f.brainA, {
      channel: f.channel.id, threadId: threaded ? first.id : null, body: "Deferred new live message",
    });
    await act(async () => SocketFixture.instances[0]!.emit("message", incoming));
    assert.equal(stream.querySelectorAll(".msg-b").length, displayedCount);
    assert.ok(anchor.isConnected, "the reading DOM node must not be evicted");
    assert.equal(selection.toString(), selected, "copy/selection must remain usable");
    assert.equal(stream.scrollTop, 300);
    assert.ok(!stream.textContent!.includes(incoming.body));
    assert.ok(receipts.every((seqs) => !seqs.includes(incoming.seq)), "deferred mail is not rendered/read");
    // A reconnect refresh must not replace the user's held reading window either.
    await act(async () => SocketFixture.instances[0]!.emit("hello", undefined));
    assert.ok(anchor.isConnected);
    assert.equal(selection.toString(), selected);
    selection.removeAllRanges();
    await f.click(f.button(threaded ? "New replies — refresh thread" : "New messages — jump to recent", scope));
    const refreshed = threaded ? f.host.querySelector("aside.thread")! : f.host.querySelector("main.desk")!;
    assert.ok(refreshed.querySelectorAll(".msg-b").length <= 500);
    if (!threaded) assert.ok(refreshed.textContent!.includes(incoming.body));
  });
}

for (const reconnect of [false, true]) {
  test(`mounted App preserves channel live events delivered during a delayed ${reconnect ? "reconnect" : "initial"} snapshot`, async t => {
    const f = await fixture(t);
    f.hive.channels.invite(f.human, f.channel.id, [f.brainA.name]);
    const rootMessage = f.hive.messages.postMessage(f.brainA, { channel: f.channel.id, body: "Race root fixture" });
    const initialReply = f.hive.messages.postMessage(f.brainA, { channel: f.channel.id, threadId: rootMessage.id, body: "Reply present in snapshot" });
    let release!: () => void, captured!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { captured = resolve; });
    let delay = !reconnect;
    const original = api.messages;
    t.mock.method(api, "messages", async (...args: Parameters<typeof api.messages>) => {
      const data = await original(...args);
      if (delay && args[0] === f.channel.id && args[1] === null) {
        delay = false;
        assert.ok(data.snapshotSeq! >= initialReply.seq, "snapshot fence must include non-root replies");
        captured(); await pending;
      }
      return data;
    });
    t.after(() => release());
    await act(async () => f.root.render(createElement(App)));
    const socket = SocketFixture.instances[0]!;
    if (reconnect) {
      delay = true;
      await act(async () => socket.emit("hello", undefined));
    }
    await ready;
    const newRoot = f.hive.messages.postMessage(f.brainA, { channel: f.channel.id, body: "Root delivered during pending snapshot" });
    const reply = f.hive.messages.postMessage(f.brainA, { channel: f.channel.id, threadId: rootMessage.id, body: "Reply delivered during pending snapshot" });
    const reacted = f.hive.messages.toggleReaction(f.human, rootMessage.seq, "✅").message;
    const blocked = f.hive.messages.setThreadStatus(f.brainA, rootMessage.id, "blocked");
    await act(async () => {
      socket.emit("message", newRoot); socket.emit("message", reply);
      socket.emit("reaction", { message: reacted }); socket.emit("thread", blocked);
      release();
    });
    await act(async () => { socket.emit("message", reply); socket.emit("message", newRoot); });
    const rootRow = Array.from(f.host.querySelectorAll(".msg")).find(row => row.querySelector(".msg-b")?.textContent?.includes(rootMessage.body));
    assert.ok(rootRow, "original root must remain visible");
    assert.match(rootRow.querySelector(".replies")!.textContent!, /2 replies/);
    assert.ok(rootRow.querySelector(".st-blocked"));
    assert.match(rootRow.querySelector(".reacts")!.textContent!, /✅/);
    assert.equal(Array.from(f.host.querySelectorAll(".msg-b")).filter(body => body.textContent?.includes(newRoot.body)).length, 1);
  });
}

for (const alwaysOverflow of [false, true]) {
  test(`mounted channel refresh ${alwaysOverflow ? "fails visibly after three bounded attempts" : "retries a bounded live journal overflow"}`, async t => {
    const f = await fixture(t);
    const stable = f.hive.bots.postBotMessage(f.botA.bot, f.channel.id, { eventId: "stable", body: "Stable reading anchor" }).message;
    await act(async () => f.root.render(createElement(App)));
    const original = api.messages;
    let attempts = 0;
    t.mock.method(api, "messages", async (...args: Parameters<typeof api.messages>) => {
      const data = await original(...args);
      if (args[0] === f.channel.id && args[1] === null) {
        attempts++;
        if (alwaysOverflow || attempts === 1) {
          // Repeated status events avoid unrelated inbox-refresh work. Each
          // distinct root consumes one slot in this request's bounded journal.
          for (let i = 0; i < 501; i++) SocketFixture.instances[0]!.emit("thread", {
            id: `overflow-${i}`, channelId: f.channel.id, status: "blocked",
          });
        }
      }
      return data;
    });
    await act(async () => SocketFixture.instances[0]!.emit("hello", undefined));
    assert.equal(attempts, alwaysOverflow ? 3 : 2);
    assert.ok(f.host.textContent?.includes(stable.body));
    assert.equal(f.host.textContent?.includes("Live traffic overtook the channel refresh"), alwaysOverflow);
  });
}
