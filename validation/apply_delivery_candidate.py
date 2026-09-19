from pathlib import Path
import re
import subprocess

BASE = "1ea03e67d345607a0f8fef7d038fa71f142e6705"
EXPECTED_TREE = "1b2c15c5e7d05392b01b21cf0f69e4781929f61f"
assert subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() == BASE
p=Path("web/App.tsx");s=p.read_text();s=s.replace("inbox: { ...(current.inbox ?? {}), [q.agentId]: inbox },", "inbox: { ...current.inbox, [q.agentId]: inbox },");p.write_text(s)
p=Path("src/server/query-contracts.test.ts");s=p.read_text();s=s.replace('assert.deepEqual(receivedRaw[20]!.reactions, [{ emoji: "👍", count: 1, mine: false }]);', 'assert.equal(receivedRaw[20]!.reactions, undefined, "wait omits reaction rosters by design");\n      assert.deepEqual(hive.getVisibleMessage(brain, receivedRaw[20]!.seq).reactions,\n        [{ emoji: "👍", count: 1, mine: false }], "history preserves the complete reaction state");');p.write_text(s)
subprocess.run(["git", "add", "web/App.tsx", "src/server/query-contracts.test.ts"], check=True)
result=subprocess.run(["git", "cherry-pick", "--no-commit", "2550490b84b90a2fbcef385acc0e56755a3a2a09"])
assert result.returncode in (0, 1)
r=Path.cwd()
rx=re.compile(r'^<<<<<<<[^\n]*\n(.*?)^=======\n(.*?)^>>>>>>>[^\n]*\n',re.S|re.M)
for n in ['package.json','src/cli.ts','src/mcp/index.ts','src/server/hive.ts']:
 p=r/n; s=p.read_text(); s=rx.sub(lambda m:m[1],s)
 if n=='src/cli.ts':
  s=s.replace('hivemind send --channel NAME --body TEXT [--thread ID] [--file PATH]','hivemind send --channel NAME --body TEXT [--thread ID] [--file PATH] [--event-type progress|blocker|question|action_required]')
  s=s.replace('  hivemind search --q TEXT', '  hivemind expand --channel ID --ids MESSAGE_ID,MESSAGE_ID [--after SEQ]\n  hivemind search --q TEXT')
 if n=='src/mcp/index.ts':
  s=s.replace('import { waitUntilMail } from "./wait-loop.ts";', 'import { waitUntilMail } from "./wait-loop.ts";\nimport { digestExpansionSchema } from "../shared/digest.ts";\nimport { MESSAGE_EVENT_TYPES } from "../shared/types.ts";')
 if n=='src/server/hive.ts':
  s=s.replace('import { packWait } from "./wait-format.ts";', 'import { packWait } from "./wait-format.ts";\nimport { digestExpansionSchema } from "../shared/digest.ts";')
  s=s.replace('    // Legacy bots have revision 1', '''    if (!this.db.prepare("PRAGMA table_info(messages)").all().some(column => column.name === "event_type")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN event_type TEXT");
    }
    // Legacy bots have revision 1''')
  old='''`INSERT INTO messages (id, channel_id, thread_id, author_id, body, kind, control, mentions, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`'''
  assert old in s
  s=s.replace(old,'''`INSERT INTO messages (id, channel_id, thread_id, author_id, body, kind, control, mentions, created_at, event_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`''')
  s=s.replace('''        JSON.stringify(mentions),
        t,
      );''','''        JSON.stringify(mentions),
        t,
        input.eventType ?? null,
      );''')
  s=s.replace('''      body: row.body, kind: row.kind, control: row.control,
      mentions:''','''      body: row.body, kind: row.kind, control: row.control,
      ...(row.event_type ? { eventType: row.event_type } : {}),
      mentions:''')
 assert '<<<<<<<' not in s
 p.write_text(s)
p=Path('src/server/hive.ts');s=p.read_text();s=s.replace('SELECT * FROM messages','SELECT *, CAST(body AS BLOB) AS body FROM messages');a=s.index('type MessageRow = {');b=s.index('\n};',a);part=s[a:b].replace('body: string;', 'body: string | Uint8Array;');s=s[:a]+part+s[b:];s=s.replace('body: row.body, kind: row.kind, control: row.control,','// Read message bodies through a BLOB projection: older Node SQLite TEXT\n      // conversion truncates at embedded NUL even though the stored value is intact.\n      body: typeof row.body === "string" ? row.body : Buffer.from(row.body).toString("utf8"),\n      kind: row.kind, control: row.control,');p.write_text(s)
p=Path('src/mcp/wait-loop.ts');s=p.read_text();s=s.replace('    retryDelayMs?: number;','    retryDelayMs?: number;\n    maxRetryDelayMs?: number;\n    random?: () => number;');s=s.replace('  const maxServerErrors = opts.maxServerErrors ?? Number.POSITIVE_INFINITY;\n  const maxTransientErrors = opts.maxTransientErrors ?? Number.POSITIVE_INFINITY;', '''  const maxRetryDelayMs = opts.maxRetryDelayMs ?? 30_000;
  const random = opts.random ?? Math.random;
  // Bound failed attempts, never successful idle long polls.
  const maxServerErrors = opts.maxServerErrors ?? 8;
  const maxTransientErrors = opts.maxTransientErrors ?? 8;
  for (const [name, limit] of [["maxServerErrors", maxServerErrors], ["maxTransientErrors", maxTransientErrors]] as const) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`${name} must be a positive finite integer`);
  }
  for (const [name, ms] of [["retryDelayMs", retryDelayMs], ["maxRetryDelayMs", maxRetryDelayMs]] as const) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`${name} must be a nonnegative finite duration`);
  }''');s=s.replace('      await delay(retryDelayMs, opts.signal);', '''      const ceiling = Math.min(maxRetryDelayMs, retryDelayMs * 2 ** Math.min(transientErrors - 1, 20));
      const sample = random();
      const fraction = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
      await delay(Math.round(ceiling / 2 + (ceiling / 2) * fraction), opts.signal);''');p.write_text(s)
p=Path('src/mcp/wait-loop.test.ts');s=p.read_text().replace('waitUntilMail retries fetch failed without throwing','waitUntilMail honors an explicitly larger finite retry budget');s=s.replace('{ delay: async () => undefined },','{ delay: async () => undefined, maxTransientErrors: 32 },',1);p.write_text(s)
Path('src/mcp/wait-retry-budget.test.ts').write_text('''import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../client/http.ts";
import { waitUntilMail } from "./wait-loop.ts";
import type { WaitResult } from "../shared/types.ts";

const idle = (): WaitResult => ({ idle: true, next: "", you: {} as WaitResult["you"], control: [], mentions: [], messages: [] });
const mail = (): WaitResult => ({ ...idle(), idle: false, messages: [{ id: "fixture" } as WaitResult["messages"][number]] });

for (const error of [new TypeError("fetch failed"), new HttpError(503, "unavailable")]) {
  test(`default retry budget stops eight consecutive ${error.name} failures`, async () => {
    let calls = 0;
    const delays: number[] = [];
    await assert.rejects(waitUntilMail(async () => { calls++; throw error; }, {
      delay: async ms => { delays.push(ms); }, random: () => 1,
    }), error);
    assert.equal(calls, 8);
    assert.deepEqual(delays, [1500, 3000, 6000, 12000, 24000, 30000, 30000]);
  });
}

for (const [sample, expected] of [[0, 750], [1, 1500], [-1, 750], [2, 1500], [NaN, 1125]]) {
  test(`equal jitter clamps random sample ${sample}`, async () => {
    let calls = 0;
    const delays: number[] = [];
    await waitUntilMail(async () => { if (++calls === 1) throw new TypeError("fetch failed"); return mail(); }, {
      random: () => sample, delay: async ms => { delays.push(ms); },
    });
    assert.deepEqual(delays, [expected]);
  });
}

test("successful idle resets both counters and backoff without limiting idle polls", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await waitUntilMail(async () => {
    calls++;
    if (calls <= 7 || (calls >= 1009 && calls <= 1015)) throw new HttpError(500, "unavailable");
    return calls === 1016 ? mail() : idle();
  }, { random: () => 1, delay: async ms => { delays.push(ms); } });
  assert.equal(calls, 1016);
  assert.equal(result.idle, false);
  assert.equal(delays.length, 14);
  assert.deepEqual(delays.slice(0, 7), delays.slice(7));
});

for (const status of [401, 403, 404, 409]) {
  test(`typed HTTP ${status} errors never retry`, async () => {
    let calls = 0;
    const error = new HttpError(status, "not retryable");
    await assert.rejects(waitUntilMail(async () => { calls++; throw error; }, {
      delay: async () => { assert.fail("fatal error was retried"); },
    }), error);
    assert.equal(calls, 1);
  });
}

test("invalid budgets are rejected before sending any request", async () => {
  for (const key of ["maxServerErrors", "maxTransientErrors"] as const) {
    for (const value of [0, -1, 1.5, Infinity, NaN]) {
      await assert.rejects(waitUntilMail(async () => { assert.fail("invalid budget sent a request"); }, { [key]: value }), RangeError);
    }
  }
  for (const key of ["retryDelayMs", "maxRetryDelayMs"] as const) {
    for (const value of [-1, Infinity, NaN]) {
      await assert.rejects(waitUntilMail(async () => { assert.fail("invalid delay sent a request"); }, { [key]: value }), RangeError);
    }
  }
});
''')
subprocess.run(["git", "add", "src", "web", "README.md", "BOT-PROTOCOL.md", "DELIVERY-PROTOCOL.md", "package.json"], check=True)
subprocess.run(["git", "diff", "--cached", "--check"], check=True)
actual=subprocess.check_output(["git", "write-tree"], text=True).strip()
assert actual == EXPECTED_TREE, f"Candidate tree differs from locally validated source: {actual}"
print("Verified candidate tree:", actual)
