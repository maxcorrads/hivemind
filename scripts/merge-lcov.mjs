import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function normalizeSource(source, cwd = process.cwd()) {
  let value = source.startsWith("file://") ? fileURLToPath(source) : source;
  value = value.replaceAll("\\", "/");
  const workspace = value.match(/\/hivemind\/hivemind\/(.+)$/);
  if (workspace) return workspace[1];
  if (path.isAbsolute(value)) {
    const relative = path.relative(cwd, value).replaceAll("\\", "/");
    if (!relative.startsWith("../")) return relative;
  }
  return value;
}

export function parseLcov(text, cwd = process.cwd()) {
  const records = [];
  let record = null;
  let functionHits = new Map();

  function finish() {
    if (!record) return;
    for (const [name, count] of functionHits) {
      const existing = record.functions.get(name) ?? { descriptor: "0", count: 0 };
      existing.count += count;
      record.functions.set(name, existing);
    }
    records.push(record);
    record = null;
    functionHits = new Map();
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("SF:")) {
      finish();
      record = {
        source: normalizeSource(line.slice(3), cwd),
        functions: new Map(),
        branches: new Map(),
        lines: new Map(),
      };
    } else if (!record) {
      continue;
    } else if (line.startsWith("FN:")) {
      const parts = line.slice(3).split(",");
      const name = parts.pop();
      record.functions.set(name, record.functions.get(name) ?? { descriptor: parts.join(","), count: 0 });
    } else if (line.startsWith("FNDA:")) {
      const comma = line.indexOf(",", 5);
      const count = Number(line.slice(5, comma));
      const name = line.slice(comma + 1);
      functionHits.set(name, (functionHits.get(name) ?? 0) + (Number.isFinite(count) ? count : 0));
    } else if (line.startsWith("BRDA:")) {
      const [lineNo, block, branch, takenRaw] = line.slice(5).split(",");
      const key = [lineNo, block, branch].join(",");
      const taken = takenRaw === "-" ? null : Number(takenRaw);
      const previous = record.branches.get(key);
      const count = Number.isFinite(taken)
        ? (Number.isFinite(previous?.count) ? previous.count : 0) + taken
        : previous?.count ?? null;
      record.branches.set(key, { line: lineNo, block, branch, count });
    } else if (line.startsWith("DA:")) {
      const [lineNo, countRaw, checksum] = line.slice(3).split(",");
      const count = Number(countRaw);
      const previous = record.lines.get(lineNo);
      record.lines.set(lineNo, {
        count: (previous?.count ?? 0) + (Number.isFinite(count) ? count : 0),
        checksum: previous?.checksum ?? checksum,
      });
    } else if (line === "end_of_record") {
      finish();
    }
  }
  finish();
  return records;
}

export function mergeRecords(records) {
  const merged = new Map();
  for (const record of records) {
    const target = merged.get(record.source) ?? {
      source: record.source,
      functions: new Map(),
      branches: new Map(),
      lines: new Map(),
    };
    for (const [name, fn] of record.functions) {
      const previous = target.functions.get(name);
      target.functions.set(name, {
        descriptor: previous?.descriptor ?? fn.descriptor,
        count: (previous?.count ?? 0) + fn.count,
      });
    }
    for (const [key, branch] of record.branches) {
      const previous = target.branches.get(key);
      target.branches.set(key, {
        ...branch,
        count: Number.isFinite(branch.count)
          ? (Number.isFinite(previous?.count) ? previous.count : 0) + branch.count
          : previous?.count ?? null,
      });
    }
    for (const [lineNo, line] of record.lines) {
      const previous = target.lines.get(lineNo);
      target.lines.set(lineNo, {
        count: (previous?.count ?? 0) + line.count,
        checksum: previous?.checksum ?? line.checksum,
      });
    }
    merged.set(record.source, target);
  }
  return [...merged.values()].sort((a, b) => a.source.localeCompare(b.source));
}

export function coverageSummary(records) {
  const summary = {
    lines: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
    branches: { found: 0, hit: 0 },
  };
  for (const record of records) {
    summary.lines.found += record.lines.size;
    summary.lines.hit += [...record.lines.values()].filter(item => item.count > 0).length;
    summary.functions.found += record.functions.size;
    summary.functions.hit += [...record.functions.values()].filter(item => item.count > 0).length;
    summary.branches.found += record.branches.size;
    summary.branches.hit += [...record.branches.values()].filter(item => Number.isFinite(item.count) && item.count > 0).length;
  }
  for (const metric of Object.values(summary)) {
    metric.percent = metric.found === 0 ? 100 : metric.hit * 100 / metric.found;
  }
  return summary;
}

export function serializeLcov(records) {
  const out = [];
  for (const record of records) {
    out.push("TN:", `SF:${record.source}`);
    for (const [name, fn] of [...record.functions].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`FN:${fn.descriptor},${name}`);
    }
    for (const [name, fn] of [...record.functions].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`FNDA:${fn.count},${name}`);
    }
    const functions = [...record.functions.values()];
    out.push(`FNF:${functions.length}`, `FNH:${functions.filter(fn => fn.count > 0).length}`);
    for (const branch of [...record.branches.values()].sort((a, b) =>
      Number(a.line) - Number(b.line) || Number(a.block) - Number(b.block) || Number(a.branch) - Number(b.branch))) {
      out.push(`BRDA:${branch.line},${branch.block},${branch.branch},${Number.isFinite(branch.count) ? branch.count : "-"}`);
    }
    const branches = [...record.branches.values()];
    out.push(`BRF:${branches.length}`, `BRH:${branches.filter(branch => Number.isFinite(branch.count) && branch.count > 0).length}`);
    for (const [lineNo, line] of [...record.lines].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      out.push(`DA:${lineNo},${line.count}${line.checksum ? `,${line.checksum}` : ""}`);
    }
    const lines = [...record.lines.values()];
    out.push(`LF:${lines.length}`, `LH:${lines.filter(line => line.count > 0).length}`, "end_of_record");
  }
  return out.join("\n") + "\n";
}

async function findCoverageFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findCoverageFiles(full));
    else if (entry.isFile() && /\.(?:info|lcov)$/.test(entry.name)) files.push(full);
  }
  return files.sort();
}

function option(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find(arg => arg.startsWith(prefix))?.slice(prefix.length);
  return value ?? fallback;
}

async function main() {
  const input = path.resolve(option("input", "artifacts/coverage-inputs"));
  const output = path.resolve(option("output", "artifacts/coverage/lcov.info"));
  const thresholds = {
    lines: Number(option("lines", "80")),
    branches: Number(option("branches", "75")),
    functions: Number(option("functions", "75")),
  };
  const files = await findCoverageFiles(input);
  if (!files.length) throw new Error(`No LCOV shard artifacts found under ${input}`);
  const parsed = [];
  for (const file of files) parsed.push(...parseLcov(await readFile(file, "utf8")));
  const merged = mergeRecords(parsed);
  const summary = coverageSummary(merged);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, serializeLcov(merged));

  for (const key of ["lines", "branches", "functions"]) {
    const metric = summary[key];
    console.log(`${key}: ${metric.percent.toFixed(2)}% (${metric.hit}/${metric.found}); required ${thresholds[key]}%`);
    if (metric.percent + Number.EPSILON < thresholds[key]) process.exitCode = 1;
  }
  console.log(`Merged ${files.length} LCOV shard artifacts into ${output}`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
