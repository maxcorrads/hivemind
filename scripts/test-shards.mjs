import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_FALLBACK_WEIGHT_MS = 250;

export function parseShardSpec(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) throw new Error("Shard must use <index>/<count>, for example 1/4");
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || count > 32 || index < 1 || index > count) {
    throw new Error("Shard index/count must be safe integers with 1 <= index <= count <= 32");
  }
  return { index, count };
}

export function planShards(files, count, weights = {}, fallbackWeightMs = DEFAULT_FALLBACK_WEIGHT_MS) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Shard count must be a positive integer");
  if (!Number.isFinite(fallbackWeightMs) || fallbackWeightMs <= 0) throw new Error("Fallback weight must be positive");

  const bins = Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    totalWeightMs: 0,
    files: [],
  }));
  const weighted = [...new Set(files)].map(file => {
    const measured = Number(weights[file]);
    return {
      file,
      weightMs: Number.isFinite(measured) && measured > 0 ? measured : fallbackWeightMs,
      measured: Number.isFinite(measured) && measured > 0,
    };
  }).sort((a, b) => b.weightMs - a.weightMs || a.file.localeCompare(b.file));

  for (const item of weighted) {
    bins.sort((a, b) =>
      a.totalWeightMs - b.totalWeightMs ||
      a.files.length - b.files.length ||
      a.index - b.index);
    bins[0].files.push(item.file);
    bins[0].totalWeightMs += item.weightMs;
  }

  return bins.sort((a, b) => a.index - b.index).map(bin => ({
    ...bin,
    files: bin.files.sort(),
  }));
}

export async function loadCiTimingWeights(root) {
  const file = path.join(root, "scripts", "ci-test-timings.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  if (data.schemaVersion !== 1 || typeof data.historicalWeightMs !== "object") {
    throw new Error("Unsupported CI timing data");
  }
  return {
    historicalWeightMs: data.historicalWeightMs,
    fallbackWeightMs: Number(data.fallbackWeightMs) || DEFAULT_FALLBACK_WEIGHT_MS,
    source: data.source,
  };
}

export async function selectHistoricalShard(root, files, value) {
  const { index, count } = parseShardSpec(value);
  const timing = await loadCiTimingWeights(root);
  const plan = planShards(files, count, timing.historicalWeightMs, timing.fallbackWeightMs);
  return { ...plan[index - 1], count, plan, source: timing.source };
}
