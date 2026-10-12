import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import { Hive } from "../src/server/hive.ts";
import { createApp } from "../src/server/app.ts";
import { USAGE_STALE_MS, type AccountSpec, type AccountUsage as Usage, type UsageSnapshot } from "../src/shared/accounts.ts";
import { AccountsSheet } from "./AccountsSheet.tsx";
import { AccountUsage, useNow } from "./AccountUsage.tsx";

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
after(() => window.happyDOM.close());

/** The fixed clock: every age and countdown below is counted from here. */
const NOW = Date.parse("2026-10-12T10:00:00Z");
const MINUTE = 60_000, DAY = 24 * 60 * MINUTE;

const spec = (patch: Partial<AccountSpec> = {}): AccountSpec => ({ driver: "codex", label: "Codex work", homePath: "", shadowPath: "", ...patch });
const usageSnapshot = (accountId: string, patch: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  accountId, capturedAt: NOW - 2 * MINUTE, source: "codex", plan: "subscription", windows: [], error: null, limitErrorAt: null, ...patch,
});
/** The time as the sheet shows it, in the viewer's locale. */
const local = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function fixture(t: TestContext) {
  t.mock.method(Date, "now", () => NOW);
  const dir = mkdtempSync(path.join(os.tmpdir(), "account-usage-ui-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const app = createApp(hive);
  const human = hive.identity.getAgent("human");
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/ui/session") return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    return app.request(url, init);
  });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const render = async () => {
    await act(async () => root.render(<AccountsSheet onClose={() => undefined} />));
    await settle();
  };
  const row = (label: string) => Array.from(host.querySelectorAll<HTMLElement>(".accounts-list li"))
    .find(li => li.querySelector("strong")?.textContent === label)!;
  return { hive, human, render, row };
}

test("an account shows each window as a bar of what is left, its reset and a countdown, under its row", async t => {
  const f = await fixture(t);
  const work = f.hive.accounts.create(f.human, spec());
  f.hive.accountUsage.record(usageSnapshot(work.id, { windows: [
    { key: "codex.primary", label: "5 h", usedPercent: 42.4, resetsAt: NOW + 134 * MINUTE },
    { key: "codex.secondary", label: "Week", usedPercent: 7, resetsAt: NOW + 3 * DAY },
  ] }));
  await f.render();
  const row = f.row("Codex work");
  const text = row.textContent!;
  assert.match(text, /Usage as of 2m ago/);
  assert.doesNotMatch(text, /stale/);
  // Full when nothing is used, empty when the window is used up.
  assert.equal(row.querySelector('progress[aria-label="5 h left"]')!.getAttribute("value"), "57.6");
  assert.equal(row.querySelector('progress[aria-label="Week left"]')!.getAttribute("value"), "93");
  assert.ok(text.includes("58% left") && text.includes("93% left"), "what is left is shown as a number, rounded");
  assert.ok(text.includes("At this pace it lasts until the reset"), "both windows last at their pace so far");
  assert.ok(text.includes(`Resets ${local(NOW + 134 * MINUTE)} · in 2 h 14 min`));
  assert.ok(text.includes(`Resets ${local(NOW + 3 * DAY)} · in 3 d`));
});

test("a window used faster than it lasts says when it runs out at this pace", async t => {
  const f = await fixture(t);
  const work = f.hive.accounts.create(f.human, spec());
  // Read 2 min ago, 1 h into a 5 h window at 40%: the other 60% go in 1.5 h, before the reset.
  f.hive.accountUsage.record(usageSnapshot(work.id, { windows: [
    { key: "codex.primary", label: "5 h", usedPercent: 40, resetsAt: NOW - 2 * MINUTE + 4 * 60 * MINUTE, windowMs: 5 * 60 * MINUTE },
  ] }));
  await f.render();
  const runsOut = NOW - 2 * MINUTE + 90 * MINUTE;
  assert.ok(f.row("Codex work").textContent!.includes(`At this pace it runs out ${local(runsOut)} · in 1 h 28 min`));
});

test("a stale read whose pace has already run the window out says so instead of a past time", async t => {
  const f = await fixture(t);
  const work = f.hive.accounts.create(f.human, spec());
  // Read a day ago, a day into a week at 90%: at that pace the rest went 2.7 h after the read, long before now.
  const read = NOW - DAY;
  f.hive.accountUsage.record(usageSnapshot(work.id, { capturedAt: read, windows: [
    { key: "codex.secondary", label: "Week", usedPercent: 90, resetsAt: read + 6 * DAY, windowMs: 7 * DAY },
  ] }));
  await f.render();
  const text = f.row("Codex work").textContent!;
  assert.match(text, /stale/);
  assert.match(text, /At this pace it is probably used up already/);
  assert.doesNotMatch(text, /runs out/);
});

test("an account with no read yet says how its numbers come, and only a real failure shows as an error", async t => {
  const f = await fixture(t);
  const claude = f.hive.accounts.create(f.human, spec({ driver: "claude", label: "Claude work", homePath: "~/.claude-work" }));
  // What older Server.app builds sent before any Claude data: not shown as a failure.
  f.hive.accountUsage.record({ accountId: claude.id, capturedAt: NOW, source: "claude", plan: "unknown", windows: [],
    error: "No recent Claude usage data", limitErrorAt: null });
  const broken = f.hive.accounts.create(f.human, spec({ label: "Codex broken", homePath: "~/.codex-broken" }));
  f.hive.accountUsage.record(usageSnapshot(broken.id, { plan: "unknown", error: "Usage read failed" }));
  f.hive.accounts.create(f.human, spec({ label: "Codex new", homePath: "~/.codex-new" }));
  await f.render();
  assert.match(f.row("Claude work").textContent!, /No usage yet\. Claude reports it from sessions Hivemind launches with this account/);
  assert.doesNotMatch(f.row("Claude work").textContent!, /Last read failed/);
  assert.match(f.row("Codex broken").textContent!, /Last read failed: Usage read failed/);
  assert.match(f.row("Codex new").textContent!, /No usage yet: Hivemind Server\.app reads it every 5 minutes/);
  assert.equal(f.row("Codex new").querySelector("progress"), null);
});

test("a stale snapshot says so, an API key has no plan window, and a limit error shows its time next to the snapshot", async t => {
  const f = await fixture(t);
  const api = f.hive.accounts.create(f.human, spec({ label: "Codex api", homePath: "~/.codex-api" }));
  f.hive.accountUsage.record(usageSnapshot(api.id, { plan: "api-key", capturedAt: NOW - (USAGE_STALE_MS + MINUTE), limitErrorAt: NOW - 5 * MINUTE }));
  await f.render();
  const row = f.row("Codex api");
  assert.match(row.textContent!, /Usage as of 11m ago · stale/);
  assert.match(row.textContent!, /API key: no plan window/);
  assert.ok(row.textContent!.includes(`Limit error at ${local(NOW - 5 * MINUTE)}`));
  assert.equal(row.querySelector("progress"), null);
});

test("the countdown is drawn again every 30 s, without a reload", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const usage: Usage = { accountId: "codex-work", snapshot: usageSnapshot("codex-work", { windows: [
    { key: "codex.primary", label: "5 h", usedPercent: 10, resetsAt: NOW + 10 * MINUTE },
  ] }), lastAttemptAt: NOW, lastError: null, limitResetAt: null, limitErrorAt: null };
  function Live() {
    const now = useNow();
    return <AccountUsage usage={usage} now={now} driver="codex" />;
  }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Live />));
    assert.match(host.textContent!, /in 10 min/);
    await act(async () => { t.mock.timers.tick(30_000); });
    assert.match(host.textContent!, /in 9 min/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
