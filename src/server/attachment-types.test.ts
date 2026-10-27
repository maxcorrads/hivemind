import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Hive } from "./hive.ts";
import { createApp } from "./app.ts";
import { findRow } from "./test-fixtures.ts";
import { FILES_PER_MESSAGE, type AttachmentMeta, type Message } from "../shared/types.ts";

// Attachments of any type (docs/remote-hosts.md#attachments-of-any-type): every type is stored, only the
// safe preview list is served inline, and everything else is a sandboxed download that never runs.

const SCRIPTED = [
  { name: "page.html", mime: "text/html", bytes: "<script>parent.document.title='owned'</script>" },
  { name: "logo.svg", mime: "image/svg+xml", bytes: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>" },
  { name: "page.xhtml", mime: "application/xhtml+xml", bytes: "<html xmlns='http://www.w3.org/1999/xhtml'><script>1</script></html>" },
];
/** The types that were served inline before, still served exactly so. */
const SAFE = [
  { name: "shot.png", mime: "image/png" }, { name: "photo.jpg", mime: "image/jpeg" }, { name: "clip.webp", mime: "image/webp" },
  { name: "anim.gif", mime: "image/gif" }, { name: "report.pdf", mime: "application/pdf" }, { name: "notes.txt", mime: "text/plain" },
];

function setup(t: TestContext, uploadLimits = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-attachment-types-"));
  const hive = new Hive(path.join(dir, "hive.db"), { uploadLimits });
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const app = createApp(hive);
  const human = hive.identity.getAgent("human");
  const brain = hive.identity.join({ role: "brain" });
  const channel = hive.channels.createChannel(human, { name: "Files", type: "private", project: "acme", memberNames: [brain.agent.name] });
  const upload = async (name: string, mime: string | null, bytes: string, token?: string) => {
    const res = await app.request(token ? "/api/agent/files" : "/api/ui/files", { method: "POST", body: bytes,
      headers: { "x-file-name": name, "content-length": String(Buffer.byteLength(bytes)), ...(mime === null ? {} : { "x-file-mime": mime }),
        ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    assert.equal(res.status, 200, `upload ${name}`);
    return (await res.json() as { file: AttachmentMeta }).file;
  };
  const download = (id: string, token?: string) => app.request(token ? `/api/agent/files/${id}` : `/api/ui/files/${id}`,
    token ? { headers: { authorization: `Bearer ${token}` } } : {});
  return { hive, app, human, brain, channel, upload, download };
}

function assertSandboxedDownload(res: Response, mime: string, name: string) {
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream", `${mime} is never served under its own type`);
  assert.equal(res.headers.get("content-disposition"), `attachment; filename="${name}"`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy") ?? "", /^sandbox(;|$)/);
  assert.equal(res.headers.get("x-file-mime"), mime, "the sender's type still reaches the client");
}

test("HTML and SVG uploads are stored with the sender's type and only ever served as sandboxed downloads", async (t) => {
  const f = setup(t);
  for (const file of SCRIPTED) {
    const meta = await f.upload(file.name, file.mime, file.bytes);
    assert.equal(meta.mime, file.mime);
    assert.equal(findRow(f.hive, "attachments", { id: meta.id }, "mime")?.mime, file.mime);
    const human = await f.download(meta.id);
    assertSandboxedDownload(human, file.mime, file.name);
    assert.equal(await human.text(), file.bytes, "the bytes are stored unchanged");
  }
  // From an agent too, and through the agent route.
  const svg = await f.upload("chart.svg", "image/svg+xml", SCRIPTED[1]!.bytes, f.brain.token);
  const posted = f.hive.messages.postMessage(f.brain.agent, { channel: f.channel.id, body: "chart", attachmentIds: [svg.id] });
  assert.equal(posted.attachments?.[0]?.mime, "image/svg+xml", "the API reports the sender's type");
  const history = await (await f.app.request(`/api/ui/channels/${f.channel.id}/messages`)).json() as { messages: Message[] };
  assert.equal(history.messages.find(m => m.id === posted.id)?.attachments?.[0]?.mime, "image/svg+xml");
  assertSandboxedDownload(await f.download(svg.id), "image/svg+xml", "chart.svg");
  assertSandboxedDownload(await f.download(svg.id, f.brain.token), "image/svg+xml", "chart.svg");
});

test("types with no preview upload whatever they are: declared, guessed from the name, or opaque", async (t) => {
  const f = setup(t);
  const cases: Array<[string, string | null, string]> = [
    ["archive.tar.gz", "application/gzip", "application/gzip"],
    ["data.csv", "text/csv", "text/csv"],
    ["data.json", "application/json", "application/json"],
    ["bundle.zip", "application/zip", "application/zip"],
    ["sheet.xlsx", null, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["README.md", "", "text/markdown"],
    ["blob.bin", "application/octet-stream", "application/octet-stream"],
    ["noext", null, "application/octet-stream"],
    ["caps.txt", "Text/Plain; charset=UTF-8", "text/plain"],
    ["bad.txt", "not a type", "text/plain"],
    ["odd.txt", "text/<html>", "text/plain"],
  ];
  for (const [name, declared, stored] of cases) {
    const meta = await f.upload(name, declared, "fixture bytes");
    assert.equal(meta.mime, stored, name);
    const res = await f.download(meta.id);
    if (stored === "text/plain") assert.equal(res.headers.get("content-type"), "text/plain");
    else assertSandboxedDownload(res, stored, name.replace(/[^A-Za-z0-9._-]/g, "_"));
  }
  // Direct callers (Telegram, bots) still cannot store a malformed type: downloads echo it in a header.
  await assert.rejects(f.hive.files.createFileFromBytes(f.human, { name: "x", mime: "text/html\r\nx: 1", bytes: Buffer.from("x") }), /Invalid file type/);
  await assert.rejects(f.hive.files.createFileFromBytes(f.human, { name: "x", mime: "", bytes: Buffer.from("x") }), /Invalid file type/);
});

test("compatibility: the safe types upload and preview inline exactly as before, without the sandbox", async (t) => {
  const f = setup(t);
  for (const file of SAFE) {
    const meta = await f.upload(file.name, file.mime, "fixture bytes");
    assert.deepEqual({ name: meta.name, mime: meta.mime, bytes: meta.bytes }, { name: file.name, mime: file.mime, bytes: 13 });
    // A browser's empty or generic type still resolves from the name, as before.
    assert.equal((await f.upload(file.name, "", "x")).mime, file.mime);
    assert.equal((await f.upload(file.name, "application/octet-stream", "x")).mime, file.mime);
    // Through the agent route as well, for the brain's own upload.
    const own = await f.upload(file.name, file.mime, "fixture bytes", f.brain.token);
    for (const res of [await f.download(meta.id), await f.download(own.id, f.brain.token)]) {
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), file.mime);
      assert.equal(res.headers.get("content-disposition"), `inline; filename="${file.name}"`);
      assert.equal(res.headers.get("content-length"), "13");
      assert.equal(res.headers.get("content-security-policy"), null);
      assert.equal(await res.text(), "fixture bytes");
    }
  }
  // A paste with no name or type is still a PNG.
  const paste = await f.app.request("/api/ui/files", { method: "POST", body: "x" });
  assert.equal((await paste.json() as { file: AttachmentMeta }).file.mime, "image/png");
});

test("any type keeps the per-message count, the per-file size and the quota limits", async (t) => {
  const f = setup(t, { totalBytes: 64 });
  const ids: string[] = [];
  for (let i = 0; i <= FILES_PER_MESSAGE; i++) ids.push((await f.upload(`page-${i}.html`, "text/html", "<p>x</p>")).id);
  assert.throws(() => f.hive.messages.postMessage(f.human, { channel: f.channel.id, body: "files", attachmentIds: ids }), { status: 400 });
  const sent = f.hive.messages.postMessage(f.human, { channel: f.channel.id, body: "files", attachmentIds: ids.slice(0, FILES_PER_MESSAGE) });
  assert.equal(sent.attachments?.length, FILES_PER_MESSAGE);
  const oversized = await f.app.request("/api/ui/files", { method: "POST", body: "xx",
    headers: { "x-file-name": "page.html", "x-file-mime": "text/html", "content-length": String(512 * 1024 * 1024 + 1) } });
  assert.equal(oversized.status, 400);
  const overQuota = await f.app.request("/api/ui/files", { method: "POST", body: "y".repeat(64),
    headers: { "x-file-name": "big.svg", "x-file-mime": "image/svg+xml", "content-length": "64" } });
  assert.equal(overQuota.status, 507);
});
