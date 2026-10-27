import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import { Hive } from "../src/server/hive.ts";
import { createApp } from "../src/server/app.ts";
import { parseLaunchEnvironment } from "../src/shared/launch-environment.ts";
import { emptyTemplateSpec, environmentText, secretNamesFrom, templateCommandPreview, WorkerTemplatesSheet } from "./WorkerTemplates.tsx";

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
after(() => window.happyDOM.close());

test("environment text round-trips through the field's parser, quotes included", () => {
  const environment = { PLAIN: "1", JSON: '{"snapshot":false}', DOUBLE: '"quoted"', SINGLE: "'quoted'", EMPTY: "", SPACES: "  a b  " };
  assert.deepEqual(parseLaunchEnvironment(environmentText(environment)).environment, environment);
  assert.deepEqual(secretNamesFrom(" OPENCODE_API_KEY \n\nOTHER_KEY\n"), ["OPENCODE_API_KEY", "OTHER_KEY"]);
});

test("the command preview uses the launch builder and reports what it refuses", () => {
  const project = { slug: "acme", worktree: "/work/acme" };
  const ok = templateCommandPreview({ ...emptyTemplateSpec(), software: "codex2", model: "gpt-6-sol", effort: "high",
    environment: { OPENCODE_DISABLE_FFF: "1" } }, project);
  assert.ok(ok.ok);
  assert.match(ok.text, /^OPENCODE_DISABLE_FFF='1' /);
  assert.match(ok.text, /codex2/);
  assert.match(ok.text, /gpt-6-sol/);
  const refused = templateCommandPreview({ ...emptyTemplateSpec(), extraFlags: "--x $(whoami)" }, project);
  assert.equal(refused.ok, false);
});

async function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-templates-ui-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const app = createApp(hive);
  const project = hive.projects.listProjects()[0]!;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/ui/session") return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    return app.request(url, init);
  });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let closed = 0;
  t.after(async () => { await act(async () => root.unmount()); host.remove(); await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  await act(async () => root.render(<WorkerTemplatesSheet project={project} onClose={() => { closed++; }} />));
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  await settle();
  // Inside an open confirmation, only its buttons: the row behind it has a "Delete" button too.
  const button = (label: string) => Array.from((document.querySelector('[role="alertdialog"]') ?? document).querySelectorAll("button"))
    .find(b => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
  const click = async (label: string) => { const b = button(label); assert.ok(b, label); await act(async () => b.click()); await settle(); };
  const field = (label: string) => {
    const found = Array.from(host.querySelectorAll("label")).find(l => l.firstChild?.textContent?.trim() === label);
    const control = found?.querySelector("input, textarea");
    assert.ok(control, label);
    return control as unknown as HTMLInputElement;
  };
  const type = async (label: string, value: string) => {
    const control = field(label);
    const proto = control.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(control, value);
      control.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
  };
  const submit = async () => {
    const form = host.querySelector("form")!;
    await act(async () => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); });
    await settle();
  };
  return { hive, project, host, click, type, field, submit, button, closed: () => closed };
}

test("Human creates, edits, duplicates and deletes a template from the sheet", async t => {
  const f = await fixture(t);
  assert.match(f.host.textContent!, /No templates yet/);
  await f.click("New template");
  await f.type("Name", "Codex senior");
  await f.type("Slug", "codex-senior");
  await f.type("When to use it", "Backend work that needs care.");
  await f.type("Software", "codex2");
  await f.type("Environment variables", "OPENCODE_DISABLE_FFF=1");
  await f.type("Secret names", "OPENCODE_API_KEY");
  assert.match(f.host.querySelector(".launch-pre")!.textContent!, /OPENCODE_DISABLE_FFF='1' .*codex2/);
  await f.submit();

  const [saved] = f.hive.workerTemplates.list(f.project.id);
  assert.ok(saved);
  assert.equal(saved.slug, "codex-senior");
  assert.deepEqual(saved.spec.environment, { OPENCODE_DISABLE_FFF: "1" });
  assert.deepEqual(saved.spec.secretNames, ["OPENCODE_API_KEY"]);
  assert.match(f.host.textContent!, /Codex senior/);
  assert.match(f.host.textContent!, /Secrets: OPENCODE_API_KEY/);

  await f.click("Edit Codex senior");
  assert.match(f.host.textContent!, /Secret values are entered in Hivemind\.app on the Mac or in the iPhone\/iPad app/,
    "a browser has no bridge to Hivemind Server's Keychain");
  await f.type("At most at once", "4");
  await f.submit();
  assert.equal(f.hive.workerTemplates.get(saved.id).spec.maxConcurrent, 4);
  assert.equal(f.hive.workerTemplates.get(saved.id).revision, 2);

  await f.click("Duplicate Codex senior");
  assert.equal(f.field("Slug").value, "codex-senior-copy");
  await f.submit();
  assert.equal(f.hive.workerTemplates.list(f.project.id).length, 2);

  await f.click("Delete Codex senior (copy)");
  await f.click("Cancel");
  assert.equal(f.hive.workerTemplates.list(f.project.id).length, 2);
  await f.click("Delete Codex senior (copy)");
  await f.click("Delete");
  assert.deepEqual(f.hive.workerTemplates.list(f.project.id).map(item => item.slug), ["codex-senior"]);
});

test("the server's reason is shown and nothing is saved", async t => {
  const f = await fixture(t);
  await f.click("New template");
  await f.type("Name", "Bad");
  await f.type("Slug", "bad");
  await f.type("When to use it", "Never.");
  await f.type("Secret names", "HIVEMIND_TOKEN");
  await f.submit();
  assert.match(f.host.querySelector('[role="alert"]')!.textContent!, /secretNames: HIVEMIND_TOKEN/);
  assert.deepEqual(f.hive.workerTemplates.list(f.project.id), []);
});

test("the Account select follows Software: a pin saves, clears, and moves off when the driver changes", async t => {
  const f = await fixture(t);
  const human = f.hive.identity.getAgent("human");
  const codex = f.hive.accounts.create(human, { driver: "codex", label: "Codex work", homePath: "~/.codex-work", shadowPath: "" });
  f.hive.accounts.create(human, { driver: "codex", label: "Codex personal", homePath: "", shadowPath: "~/.codex-personal" });
  f.hive.accounts.create(human, { driver: "claude", label: "Claude work", homePath: "~/.claude-work", shadowPath: "" });
  const accountSelect = () => Array.from(f.host.querySelectorAll("label"))
    .find(label => label.firstChild?.textContent?.trim() === "Account")?.querySelector("select") ?? null;
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 50 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(check());
  };
  const choose = async (value: string) => {
    const select = accountSelect();
    assert.ok(select, "the Account select");
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
    });
  };

  await f.click("New template");
  await until(() => accountSelect() !== null);
  assert.deepEqual(Array.from(accountSelect()!.options).map(option => option.textContent),
    ["Follow the Sequential policy", "Codex work", "Codex personal"]);
  await choose(codex.id);
  await f.type("Name", "Codex pinned");
  await f.type("Slug", "codex-pinned");
  await f.type("When to use it", "Pinned to the work login.");
  await f.submit();
  const [saved] = f.hive.workerTemplates.list(f.project.id);
  assert.equal(saved!.spec.accountId, codex.id);

  await f.click("Edit Codex pinned");
  await until(() => accountSelect() !== null);
  assert.equal(accountSelect()!.value, codex.id, "the saved pin is shown");
  await choose("");
  await f.submit();
  assert.equal(f.hive.workerTemplates.get(saved!.id).spec.accountId, null, "clearing the pin follows the policy");

  await f.click("Edit Codex pinned");
  await until(() => accountSelect() !== null);
  await choose(codex.id);
  await f.type("Software", "claude");
  assert.equal(accountSelect()!.value, "", "the pin moves off when the driver changes");
  assert.deepEqual(Array.from(accountSelect()!.options).map(option => option.textContent), ["Follow the Sequential policy", "Claude work"]);
  await f.type("Software", "codex2");
  assert.equal(accountSelect(), null, "an alias of a driver has no account select");
});

test("the Account select names the driver's policy and stays hidden for a driver without accounts", async t => {
  const f = await fixture(t);
  const human = f.hive.identity.getAgent("human");
  f.hive.accounts.create(human, { driver: "codex", label: "Codex work", homePath: "~/.codex-work", shadowPath: "" });
  f.hive.accounts.setPolicy(human, "codex", "balanced");
  const accountSelect = () => Array.from(f.host.querySelectorAll("label"))
    .find(label => label.firstChild?.textContent?.trim() === "Account")?.querySelector("select") ?? null;
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 50 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(check());
  };

  await f.click("New template");
  await until(() => accountSelect() !== null);
  assert.deepEqual(Array.from(accountSelect()!.options).map(option => option.textContent), ["Follow the Balanced policy", "Codex work"]);
  await f.type("Software", "claude");
  assert.equal(accountSelect(), null, "Claude has no accounts");
  await f.type("Software", "codex");
  assert.ok(accountSelect(), "the select comes back with Codex");
});

test("an alias of a driver with accounts shows a hint that never blocks Save", async t => {
  const f = await fixture(t);
  const human = f.hive.identity.getAgent("human");
  f.hive.accounts.create(human, { driver: "codex", label: "Codex work", homePath: "~/.codex-work", shadowPath: "" });
  const hint = "codex2 launches without a Codex account: accounts apply only when Software is exactly codex.";
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 50 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(check());
  };

  await f.click("New template");
  await f.type("Name", "Codex alias");
  await f.type("Slug", "codex-alias");
  await f.type("When to use it", "Alias check.");
  await f.type("Software", "codex2");
  await until(() => f.host.textContent!.includes(hint));
  assert.equal(f.button("Save template")!.disabled, false, "the hint does not disable Save");
  await f.submit();
  const [saved] = f.hive.workerTemplates.list(f.project.id);
  assert.equal(saved?.spec.software, "codex2", "the template saves with the alias");

  await f.click("Edit Codex alias");
  await until(() => f.host.textContent!.includes(hint));
  await f.type("Software", "codex");
  assert.equal(f.host.textContent!.includes("launches without a Codex account"), false, "the exact command has no hint");
});

test("an alias hint names its own driver, and an alias of a driver without accounts shows none", async t => {
  const f = await fixture(t);
  const human = f.hive.identity.getAgent("human");
  f.hive.accounts.create(human, { driver: "claude", label: "Claude work", homePath: "~/.claude-work", shadowPath: "" });
  const accountSelect = () => Array.from(f.host.querySelectorAll("label"))
    .find(label => label.firstChild?.textContent?.trim() === "Account")?.querySelector("select") ?? null;
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 50 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(check());
  };

  await f.click("New template");
  await f.type("Software", "claude");
  await until(() => accountSelect() !== null);
  await f.type("Software", "codex2");
  assert.equal(f.host.textContent!.includes("launches without"), false, "Codex has no accounts");
  await f.type("Software", "claude-work");
  assert.match(f.host.textContent!, /claude-work launches without a Claude account: accounts apply only when Software is exactly claude\./);
});

test("the Host select shows only with hosts, saves the host, and This Mac leaves a new template without the field", async t => {
  const f = await fixture(t);
  const hostSelect = () => Array.from(f.host.querySelectorAll("label"))
    .find(label => label.firstChild?.textContent?.trim() === "Host")?.querySelector("select") ?? null;
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const fill = async (name: string) => {
    await f.type("Name", name);
    await f.type("Slug", name.toLowerCase().replace(/ /g, "-"));
    await f.type("When to use it", "Work on a host.");
  };

  await f.click("New template");
  await settle();
  assert.equal(hostSelect(), null, "no host, no field");
  await fill("Local worker");
  await f.submit();
  assert.equal("hostId" in f.hive.workerTemplates.list(f.project.id)[0]!.spec, false, "saved as before hosts");

  const buildMac = { id: "20000000-0000-4000-8000-000000000001", label: "Build Mac", online: true };
  f.hive.hosts.replace({ hosts: [buildMac] });
  await f.click("New template");
  await settle();
  const select = hostSelect();
  assert.ok(select, "the Host select");
  assert.deepEqual(Array.from(select.options).map(option => option.textContent), ["This Mac", "Build Mac"]);
  await act(async () => {
    select.value = buildMac.id;
    select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  });
  await fill("Remote worker");
  await f.submit();
  const remote = f.hive.workerTemplates.list(f.project.id).find(template => template.slug === "remote-worker");
  assert.equal(remote?.spec.hostId, buildMac.id);
});
