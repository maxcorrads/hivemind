import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeTerminalData, encodeTerminalInput, parseTerminalEvent, terminalDataLength, terminalSessionLaunchProblem, terminalSize,
  TERMINAL_BROKER_LIMITS, TERMINAL_EVENT, type TerminalMessage, type TerminalSessionLaunch,
} from "./native-bridge.ts";

// The page side of the terminal bridge contract (HivemindKit BridgeTerminalEvent
// and BridgeMessage on the other side). Pure: no DOM, no app, no broker.

const session = { name: "hm-acme-atlas", project: "acme", agent: "Atlas", alive: true, attached: 1, createdAt: 1_790_000_000_000 };

test("parses every terminal event the app sends", () => {
  assert.equal(TERMINAL_EVENT, "hivemind:terminal");
  const events: unknown[] = [
    { type: "terminal-status", tmux: "missing", broker: "connected" },
    { type: "sessions", items: [session, { ...session, name: "hm-acme-new-1", agent: null, project: null }] },
    { type: "sessions", items: [] },
    { type: "terminal-launched", id: "r1", names: ["hm-acme-atlas", null], created: ["hm-acme-atlas"],
      errors: [{ index: 1, code: "cwd-missing", message: "No folder" }] },
    { type: "terminal-attached", id: null, stream: 1, session: "hm-acme-atlas" },
    { type: "terminal-output", stream: 1, data: "aGk=" },
    { type: "terminal-exit", stream: 1, status: 0 },
    { type: "terminal-exit", stream: 1, status: null },
    { type: "terminal-killed", id: "k", session: "hm-acme-atlas" },
    { type: "terminal-error", id: "a", code: "no-such-session", message: "gone", stream: null },
  ];
  for (const event of events) assert.deepEqual(parseTerminalEvent(event), event);
  // A missing id or stream reads as null, as Swift's NSNull would.
  assert.deepEqual(parseTerminalEvent({ type: "terminal-error", code: "internal", message: "m" }),
    { type: "terminal-error", id: null, code: "internal", message: "m", stream: null });
});

test("drops malformed or unknown terminal events", () => {
  const bad: unknown[] = [
    null, "sessions", [], { type: "terminal-shell" },
    { type: "terminal-status", tmux: "yes", broker: "connected" },
    { type: "sessions", items: [{ ...session, name: "acme" }] },
    { type: "sessions", items: [{ ...session, attached: -1 }] },
    { type: "sessions", items: "x" },
    { type: "terminal-launched", id: null, names: ["nope"], created: [], errors: [] },
    { type: "terminal-launched", id: null, names: [], created: [], errors: [{ index: "0" }] },
    { type: "terminal-attached", id: null, stream: 0, session: "hm-acme-atlas" },
    { type: "terminal-attached", id: 5, stream: 1, session: "hm-acme-atlas" },
    { type: "terminal-output", stream: 1.5, data: "aGk=" },
    { type: "terminal-output", stream: 1, data: "" },
    { type: "terminal-exit", stream: 1, status: "0" },
    { type: "terminal-killed", id: null, session: "hm-A" },
    { type: "terminal-error", id: null, code: 1, message: "m", stream: null },
  ];
  for (const event of bad) assert.equal(parseTerminalEvent(event), null, JSON.stringify(event));
});

test("terminal input is base64 in chunks the broker takes, and output decodes back", () => {
  assert.deepEqual(encodeTerminalInput("\x03"), ["Aw=="]);
  assert.deepEqual(encodeTerminalInput(""), []);
  assert.deepEqual([...decodeTerminalData(encodeTerminalInput("héllo 🐝")[0]!)], [...new TextEncoder().encode("héllo 🐝")]);
  const paste = new Uint8Array(TERMINAL_BROKER_LIMITS.inputBytes * 2 + 5).map((_, i) => i % 256);
  const chunks = encodeTerminalInput(paste);
  assert.equal(chunks.length, 3);
  const decoded = chunks.map(decodeTerminalData);
  assert.ok(decoded.every(chunk => chunk.length <= TERMINAL_BROKER_LIMITS.inputBytes));
  assert.deepEqual(Buffer.concat(decoded), Buffer.from(paste));
  assert.deepEqual([...decodeTerminalData("not base64!")], []);
  const message: TerminalMessage = { type: "terminal-input", stream: 1, data: chunks[0]! };
  assert.equal(message.type, "terminal-input");
});

test("an ack counts the decoded bytes of the output it answers", () => {
  for (const size of [1, 2, 3, 4, 5, 64 * 1024, 64 * 1024 + 1]) {
    const data = Buffer.alloc(size, 7).toString("base64");
    assert.equal(terminalDataLength(data), size, `${size} bytes`);
    assert.equal(terminalDataLength(data), decodeTerminalData(data).length);
  }
  assert.equal(terminalDataLength(""), 0);
  const ack: TerminalMessage = { type: "terminal-ack", stream: 2, bytes: 5 };
  assert.equal(ack.type, "terminal-ack");
});

test("sizes are clamped to what the broker takes", () => {
  assert.deepEqual(terminalSize(120.7, 40.2), { cols: 120, rows: 40 });
  assert.deepEqual(terminalSize(0, 0), { cols: 2, rows: 1 });
  assert.deepEqual(terminalSize(9999, 9999), { cols: 1000, rows: 500 });
  assert.deepEqual(terminalSize(Number.NaN, Number.POSITIVE_INFINITY), { cols: 2, rows: 1 });
});

test("session launches are checked as the broker checks them", () => {
  const good: TerminalSessionLaunch = { project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: "~/acme", command: "claude" };
  assert.equal(terminalSessionLaunchProblem([good, { ...good, agent: null, cwd: null }]), null);
  assert.equal(terminalSessionLaunchProblem([{ ...good, session: "hm-acme-new-1" }, { ...good, session: null }]), null);
  assert.equal(terminalSessionLaunchProblem([{ ...good, command: "x".repeat(TERMINAL_BROKER_LIMITS.commandBytes) }]), null);
  const refused: TerminalSessionLaunch[][] = [
    [],
    Array.from({ length: TERMINAL_BROKER_LIMITS.launches + 1 }, () => good),
    [{ ...good, project: "Acme" }],
    [{ ...good, agent: "  " }],
    [{ ...good, agent: "a\tb" }],
    [{ ...good, agent: "a‍b" }],
    [{ ...good, agent: "a".repeat(TERMINAL_BROKER_LIMITS.agentChars + 1) }],
    [{ ...good, title: "t".repeat(TERMINAL_BROKER_LIMITS.titleChars + 1) }],
    [{ ...good, command: " \n" }],
    [{ ...good, command: "a\0b" }],
    [{ ...good, command: "é".repeat(TERMINAL_BROKER_LIMITS.commandBytes / 2 + 1) }],
    [{ ...good, cwd: "relative" }],
    [{ ...good, cwd: "~bob/x" }],
    [{ ...good, session: "acme-atlas" }],
  ];
  for (const launches of refused) {
    assert.notEqual(terminalSessionLaunchProblem(launches), null, JSON.stringify(launches).slice(0, 80));
  }
});
