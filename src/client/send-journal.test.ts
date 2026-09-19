import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync, readFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { SendJournal, LOCAL_SEND_LIMIT } from "./send-journal.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-send-journal-"));
  const opened: SendJournal[] = [];
  const open = () => { const journal = new SendJournal(dir); opened.push(journal); return journal; };
  t.after(() => { for (const journal of opened) { try { journal.close(); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  return { dir, open };
}

test("private durable journal preserves attachment IDs and isolates keys across client scopes", t => {
  const f = fixture(t), first = f.open(), attachment = randomUUID();
  const claim = first.claim("server-A-token-hash", "key", "payload-hash", []);
  first.uploaded("server-A-token-hash", "key", claim.nonce, [attachment]);
  first.release("server-A-token-hash", "key", claim.nonce); first.close();
  const next = f.open();
  assert.deepEqual(next.claim("server-A-token-hash", "key", "payload-hash", []).ids, [attachment]);
  assert.deepEqual(next.claim("server-B-token-hash", "key", "different", []).ids, []);
  const file = path.join(f.dir, "pending-sends/journal.sqlite");
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.equal(statSync(path.dirname(file)).mode & 0o077, 0);
  assert.ok(!readFileSync(file).includes(Buffer.from("raw-token-value")));
  assert.throws(() => next.claim("server-A-token-hash", "key", "changed", []), /another local payload/);
});

test("live owner conflicts and stale owner recovery are atomic and nonce fenced", t => {
  const f = fixture(t), first = f.open(), second = f.open();
  const one = first.claim("a", "key", "hash", []);
  assert.throws(() => second.claim("a", "key", "hash", []), /in progress/);
  first.db.prepare("UPDATE sends SET owner=1073741824 WHERE key='key'").run();
  const replacement = second.claim("a", "key", "hash", []);
  assert.notEqual(replacement.nonce, one.nonce);
  assert.throws(() => first.uploaded("a", "key", one.nonce, [randomUUID()]), /claim changed/);
  first.release("a", "key", one.nonce);
  assert.throws(() => first.claim("a", "key", "hash", []), /in progress/);
  second.release("a", "key", replacement.nonce);
  first.claim("a", "key", "hash", []);
});

test("expiry/corruption/quota fail closed without evicting active guarantees", t => {
  const f = fixture(t), journal = f.open();
  const one = journal.claim("a", "key", "hash", [], 100);
  journal.release("a", "key", one.nonce);
  assert.throws(() => journal.claim("a", "key", "hash", [], 86_400_100), /Outside/);
  journal.db.prepare("UPDATE sends SET ids='{}' WHERE key='key'").run();
  assert.throws(() => journal.claim("a", "key", "hash", [], 101));
  journal.db.exec("DELETE FROM sends; BEGIN");
  const insert = journal.db.prepare("INSERT INTO sends VALUES(?,?,?,?,?,?,?)");
  for (let i = 0; i < LOCAL_SEND_LIMIT; i++) insert.run("a", String(i), "hash", "[]", 100, null, null);
  journal.db.exec("COMMIT");
  assert.throws(() => journal.claim("a", "extra", "hash", [], 101), /full/);
  const old = journal.claim("a", "1", "hash", [], 101);
  journal.release("a", "1", old.nonce);
  assert.ok(journal.claim("a", "extra", "hash", [], 86_400_101));
  assert.ok(Number(journal.db.prepare("SELECT COUNT(*) AS n FROM sends").get()!.n) < LOCAL_SEND_LIMIT);
});

test("existing public-mode journal is not silently trusted", t => {
  const f = fixture(t); f.open().close();
  chmodSync(path.join(f.dir, "pending-sends/journal.sqlite"), 0o644);
  assert.throws(() => f.open(), /private regular/);
});
