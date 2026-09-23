import assert from "node:assert/strict";
import { test } from "node:test";
import { createSendOperations } from "./send-operation.ts";

test("uncertain UI send retries reuse uploads and key, but confirmed repeated text is a new operation", async () => {
  const file = new File(["fixture"], "a.txt"), uploadIds: string[] = [], keys: string[] = [];
  let fail = true;
  const send = createSendOperations(async () => { uploadIds.push("file-one"); return { id: "file-one" }; },
    async (_channel, _body, _root, ids, key) => {
      keys.push(key); assert.deepEqual(ids, ["file-one"]);
      if (fail) { fail = false; throw new Error("response lost after commit"); }
      return { id: "message-one" };
    });
  await assert.rejects(send("a", "hello", null, [file]), /lost/);
  await send("a", "hello", null, [file]);
  assert.equal(uploadIds.length, 1); assert.equal(keys[0], keys[1]);
  await send("a", "hello", null, [file]);
  assert.notEqual(keys[1], keys[2]); assert.equal(uploadIds.length, 2);
});

test("concurrent retries share one operation; partial upload failure resumes only missing uploads", async () => {
  const files = [new File(["one"], "one.txt"), new File(["two"], "two.txt")];
  let uploads = 0, posts = 0, fail = true;
  const run = createSendOperations(async file => {
    uploads++; if (file.name === "two.txt" && fail) { fail = false; throw new Error("upload stopped"); }
    return { id: file.name };
  }, async (_channel, _body, _root, ids) => { posts++; return ids; });
  await assert.rejects(run("a", "files", null, files));
  const first = run("a", "files", null, files), second = run("a", "files", null, files);
  assert.equal(first, second);
  assert.deepEqual(await first, ["one.txt", "two.txt"]); assert.equal(uploads, 3); assert.equal(posts, 1);
});

test("different file objects and destinations cannot accidentally reuse a key; pending memory is bounded", async () => {
  const keys: string[] = [], run = createSendOperations(async () => ({ id: "file" }), async (_c, _b, _r, _ids, key) => {
    keys.push(key); throw new Error("uncertain");
  });
  const file = new File(["a"], "same.txt");
  await assert.rejects(run("a", "same", null, [file]));
  await assert.rejects(run("a", "same", null, [new File(["b"], "same.txt")]));
  await assert.rejects(run("b", "same", null, [file]));
  assert.equal(new Set(keys).size, 3);
  for (let i = 3; i < 32; i++) await assert.rejects(run("a", String(i), null));
  await assert.rejects(run("a", "over-cap", null), /Too many/);
});

test("a retained expired operation fails visibly instead of silently choosing a new key", async t => {
  let now = 100; t.mock.method(Date, "now", () => now);
  const run = createSendOperations(async () => ({ id: "x" }), async () => { throw new Error("uncertain"); });
  await assert.rejects(run("a", "pending", null), /uncertain/);
  now += 86_400_000;
  await assert.rejects(run("a", "pending", null), /expired/);
});


test("a send carries no topology mode or lock: only its content identifies an uncertain retry (#211)", async () => {
  const keys: string[] = [], arities: number[] = [];
  const run = createSendOperations(async () => ({ id: "unused" }),
    async (...args: [string, string, string | null, string[], string]) => {
      keys.push(args[4]); arities.push(args.length); throw new Error("uncertain");
    });
  await assert.rejects(run("brain-dm", "same request", null, []), /uncertain/);
  await assert.rejects(run("brain-dm", "same request", null, []), /uncertain/);
  await assert.rejects(run("brain-dm", "other request", null, []), /uncertain/);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[1], keys[2]);
  assert.deepEqual(arities, [5, 5, 5]);
});
