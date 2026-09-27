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
