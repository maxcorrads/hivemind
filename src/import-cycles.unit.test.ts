import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Runtime import cycles make module evaluation order matter (a class or helper can be
// read before its module finished evaluating). Type-only imports are erased, so they are
// ignored: `import type`, `export type`, and `{ type A, type B }` lists without values.
// Dynamic `import()` is lazy and never part of the load-time graph.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const STATIC_IMPORT = /^[ \t]*(import|export)[ \t]+(type[ \t]+)?((?:[\w$]+[ \t]*,?[ \t]*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)?)\s*from\s*["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^[ \t]*import[ \t]*["']([^"']+)["']/gm;

/** Relative specifiers a module needs at runtime, in source order. */
export function runtimeImports(source: string): string[] {
  const specifiers: Array<[number, string]> = [];
  for (const match of source.matchAll(STATIC_IMPORT)) {
    const [, , typeOnly, clause = "", specifier = ""] = match;
    if (typeOnly) continue;
    const named = /\{([^}]*)\}/.exec(clause);
    const defaultOrNamespace = clause.replace(/\{[^}]*\}/, "").replace(/[\s,]/g, "");
    const values = named?.[1]!.split(",").map(part => part.trim()).filter(Boolean) ?? [];
    if (!defaultOrNamespace && named && values.length && values.every(part => /^type\s/.test(part))) continue;
    specifiers.push([match.index, specifier]);
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) specifiers.push([match.index, match[1]!]);
  return specifiers.sort((a, b) => a[0] - b[0]).map(([, specifier]) => specifier).filter(specifier => specifier.startsWith("."));
}

function resolveModule(from: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return undefined;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [file] : [];
  });
}

/** Cycles closed by DFS back edges: an acyclic graph yields none, a cyclic one at least one per cycle cluster. */
export function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles = new Map<string, string[]>();
  const state = new Map<string, "active" | "done">();
  const stack: string[] = [];
  const visit = (node: string) => {
    state.set(node, "active");
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === "active") {
        const cycle = stack.slice(stack.indexOf(next));
        const start = cycle.indexOf([...cycle].sort()[0]!);
        const canonical = [...cycle.slice(start), ...cycle.slice(0, start)];
        cycles.set(canonical.join(" -> "), canonical);
      } else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const node of [...graph.keys()].sort()) if (!state.has(node)) visit(node);
  return [...cycles.values()];
}

function importGraph(dirs: string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of dirs.flatMap(dir => sources(path.join(root, dir)))) {
    const edges = runtimeImports(readFileSync(file, "utf8"))
      .map(specifier => resolveModule(file, specifier))
      .filter((target): target is string => Boolean(target))
      .map(target => path.relative(root, target));
    graph.set(path.relative(root, file), edges);
  }
  return graph;
}

test("runtimeImports ignores type-only imports and keeps value and re-export edges", () => {
  const source = [
    'import type { Hive } from "./hive.ts";',
    "import { type A, type B } from './types.ts';",
    "import { type C, value } from './mixed.ts';",
    "import Default, { type D } from './default.ts';",
    "import * as ns from './ns.ts';",
    "import {\n  multi,\n  line,\n} from './multi.ts';",
    "import './side-effect.ts';",
    "export { x } from './reexport.ts';",
    "export type { Y } from './reexport-type.ts';",
    "export * from './star.ts';",
    "import { readFileSync } from 'node:fs';",
    "const lazy = () => import('./lazy.ts');",
  ].join("\n");
  assert.deepEqual(runtimeImports(source), [
    "./mixed.ts", "./default.ts", "./ns.ts", "./multi.ts", "./side-effect.ts", "./reexport.ts", "./star.ts",
  ]);
});

test("findCycles reports back-edge cycles once, canonically rotated", () => {
  const graph = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a", "d"]], ["d", []], ["e", ["e"]]]);
  assert.deepEqual(findCycles(graph), [["a", "b", "c"], ["e"]]);
});

test("src/ and web/ have no runtime import cycles", () => {
  const graph = importGraph(["src", "web"]);
  assert.ok(graph.size > 50, "source discovery found the tree");
  assert.ok((graph.get("src/server/serve.ts") ?? []).includes("src/server/hive.ts"), "graph resolves relative .ts imports");
  const cycles = findCycles(graph).map(cycle => [...cycle, cycle[0]].join(" -> "));
  assert.deepEqual(cycles, []);
});
