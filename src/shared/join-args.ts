import type { Seniority } from "./types.ts";

const SENIORITY = new Set<Seniority>(["junior", "mid", "senior"]);

export function parseJoinArgs(argv: string[]): {
  role: "brain" | "worker";
  seniority: Seniority | null;
  focus: string | null;
  resume: string | null;
  token: string | null;
  project: string | null;
  claim: string | null;
} {
  const claim = flag(argv, "--claim");
  const asIdx = argv.indexOf("--as");
  // A launch ticket joins the reserved worker it was made for: its role and seniority are already known.
  let as = asIdx >= 0 ? argv[asIdx + 1] : claim ? "worker" : undefined;
  let seniority = flag(argv, "--seniority");
  if (as && SENIORITY.has(as as Seniority)) {
    seniority = as;
    as = "worker";
  }
  if (as === "worker" && !seniority && asIdx >= 0) {
    const next = argv[asIdx + 2];
    if (next && !next.startsWith("--") && SENIORITY.has(next as Seniority)) {
      seniority = next;
    }
  }
  if (as !== "worker" && as !== "brain") {
    throw new Error("join --as worker|brain  or  --as worker junior|mid|senior");
  }
  if (seniority !== null && !SENIORITY.has(seniority as Seniority)) throw new Error("Invalid seniority");
  if (as === "worker" && !claim && (!seniority || !SENIORITY.has(seniority as Seniority))) {
    throw new Error("Workers need seniority junior|mid|senior");
  }
  return {
    role: as,
    seniority: as === "worker" && seniority ? (seniority as Seniority) : null,
    focus: flag(argv, "--focus"),
    resume: flag(argv, "--resume"),
    token: flag(argv, "--token"),
    project: flag(argv, "--project"),
    claim,
  };
}

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) return null;
  return v;
}
