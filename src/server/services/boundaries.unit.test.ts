import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Issue #169: hive.ts is a thin facade that wires the domain services in this
// directory. The services depend on narrow ports (ports.ts), never on Hive.
const here = path.dirname(fileURLToPath(import.meta.url));
const HIVE_LINE_BUDGET = 600;

const services = readdirSync(here)
  .filter(name => name.endsWith(".ts") && !/\.test\.ts$/.test(name))
  .map(name => [name, readFileSync(path.join(here, name), "utf8")] as const);

const IMPORT = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;

test("hive.ts stays within its line budget", () => {
  const lines = readFileSync(path.join(here, "..", "hive.ts"), "utf8").split("\n").length;
  assert.ok(lines < HIVE_LINE_BUDGET, `hive.ts has ${lines} lines (budget ${HIVE_LINE_BUDGET}); move logic into a service`);
});

test("services never import hive.ts, not even for types", () => {
  assert.ok(services.length >= 10, "service discovery found the directory");
  const offenders = services.flatMap(([name, source]) =>
    [...source.matchAll(IMPORT)].map(match => match[1]!)
      .filter(specifier => /(^|\/)hive(\.ts)?$/.test(specifier))
      .map(specifier => `${name} imports ${specifier}`));
  assert.deepEqual(offenders, []);
});

test("services are not typed against the Hive facade", () => {
  const offenders = services.filter(([, source]) => /\bHive\b/.test(source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")))
    .map(([name]) => name);
  assert.deepEqual(offenders, []);
});

test("ports.ts is type-only, so depending on a port never loads another module", () => {
  const ports = services.find(([name]) => name === "ports.ts")![1];
  const valueImports = [...ports.matchAll(/^\s*import\s+(?!type\b)[^;]*;/gm)].map(match => match[0].trim());
  assert.deepEqual(valueImports, []);
});
