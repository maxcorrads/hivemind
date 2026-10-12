import { z } from "zod";
import { effectiveSoftware, shSingleQuote, softwareFamily } from "./launch-prompt.ts";

/**
 * Named Codex and Claude accounts (docs/accounts.md): which login a launch of `codex` or `claude` uses, picked by a
 * pin or by the driver's policy. The catalog keeps paths, order and policy only, never a token; login stays a CLI
 * command Human runs once. HivemindKit's LaunchAccount checks the same path rules and builds the same variables
 * (src/shared/account-paths.vectors.json): keep the two in step.
 */
export const ACCOUNT_DRIVERS = ["codex", "claude"] as const;
export type AccountDriver = (typeof ACCOUNT_DRIVERS)[number];

/** Sequential: the first account until a window is used up. Balanced: the most quota left in the window that resets first. */
export const ACCOUNT_POLICIES = ["sequential", "balanced"] as const;
export type AccountPolicy = (typeof ACCOUNT_POLICIES)[number];
export type AccountPolicies = Record<AccountDriver, AccountPolicy>;

/** `label` in characters, `path` in UTF-8 bytes (macOS PATH_MAX), `perDriver` accounts in one driver's list. */
export const ACCOUNT_LIMITS = { label: 80, path: 1024, perDriver: 8 } as const;

/** The variable that points the CLI at an account's directory. */
export const ACCOUNT_ENV = { codex: "CODEX_HOME", claude: "CLAUDE_CONFIG_DIR" } as const;

/**
 * Every variable that decides which login the CLI uses. With an account none may come from the launch's environment
 * or secrets: the broker sets the account's own and unsets the rest, since a login shell's `.zshrc` could export them
 * and a token variable outranks the directory's login (docs/accounts.md#findings-claude, #findings-codex).
 */
export const ACCOUNT_CONTROLLED_ENV = {
  codex: ["CODEX_HOME", "CODEX_SQLITE_HOME", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
  claude: ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_SECURESTORAGE_CONFIG_DIR"],
} as const;

export const ACCOUNT_ERRORS = {
  exhausted: "accounts_exhausted",
  pinned: "account_pinned",
  unknown: "account_unknown",
  conflict: "account_env_conflict",
  driverMismatch: "account_driver_mismatch",
} as const;

/** The shared tree a driver uses when `homePath` is empty: the CLI's own default. */
const DEFAULT_HOME: Record<AccountDriver, string> = { codex: "~/.codex", claude: "~/.claude" };

/** Control characters (C0, DEL, C1, tab included) and lone surrogates. */
const CONTROL = /\p{Cc}|\p{Cs}/u;
/** What a login command may show unquoted: no space, quote, `$`, `~`, glob or other shell syntax. */
const SHELL_PLAIN = /^[A-Za-z0-9_./+@,:-]+$/;

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/**
 * Why `path` cannot be an account's `homePath` or `shadowPath`, or null. "" means the default. Otherwise it is stored
 * and exported exactly as written, since Claude keys its keychain login to the exact `CLAUDE_CONFIG_DIR` string:
 * absolute or `~/…` (the broker expands only that), at most 1024 bytes, no control characters, no trailing `/`,
 * no `//` and no `.` or `..` segment.
 */
export function accountPathProblem(path: string): string | null {
  if (path === "") return null;
  if (!path.startsWith("/") && !path.startsWith("~/")) return "a path starts with / or ~/";
  if (utf8Length(path) > ACCOUNT_LIMITS.path) return `a path is at most ${ACCOUNT_LIMITS.path} bytes`;
  if (CONTROL.test(path)) return "a path cannot hold control characters";
  if (path.endsWith("/")) return "a path cannot end with /";
  if (path.includes("//")) return "a path cannot hold //";
  if (path.split("/").some(segment => segment === "." || segment === "..")) return "a path cannot hold a . or .. segment";
  return null;
}

const accountPath = z.string().superRefine((path, ctx) => {
  const problem = accountPathProblem(path);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

/**
 * What Human enters for an account. `homePath` is the shared tree ("" = `~/.codex` / `~/.claude`); `shadowPath` is
 * this account's own directory ("" = a primary account, which logs in to the shared tree itself).
 */
export const accountSpecSchema = z.object({
  driver: z.enum(ACCOUNT_DRIVERS),
  label: z.string().trim().min(1).max(ACCOUNT_LIMITS.label),
  homePath: accountPath,
  shadowPath: accountPath,
}).strict().superRefine((spec, ctx) => {
  // Compared as NFC: APFS ignores normalization, Claude hashes the NFC form, and Swift's == agrees.
  if (spec.shadowPath && spec.shadowPath.normalize("NFC") === (spec.homePath || DEFAULT_HOME[spec.driver]).normalize("NFC")) {
    ctx.addIssue({ code: "custom", path: ["shadowPath"], message: "a shadow is its own directory, not the shared tree" });
  }
});

export type AccountSpec = z.infer<typeof accountSpecSchema>;

export type AgentAccount = AccountSpec & {
  id: string;
  /** Always the driver's own command; never an alias. */
  command: AccountDriver;
  /** Position in the driver's list, from 0. */
  order: number;
  revision: number;
  /** Unix ms of the last launch that picked it; balanced round-robin starts from the oldest. */
  lastSelectedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** What a launch carries to the broker: the resolved account, never the catalog. */
export type LaunchAccount = { id: string; driver: AccountDriver; label: string; homePath: string; shadowPath: string };

export function toLaunchAccount(account: AgentAccount): LaunchAccount {
  const { id, driver, label, homePath, shadowPath } = account;
  return { id, driver, label, homePath, shadowPath };
}

/**
 * The variables the broker sets for `account`, values as stored (the broker expands a leading `~/`):
 * - Codex shadow: `CODEX_HOME=<shadowPath>` and `CODEX_SQLITE_HOME=<homePath or ~/.codex>`, so every database stays
 *   in the shared home;
 * - Codex primary: `CODEX_HOME=<homePath>` when set;
 * - Claude: `CLAUDE_CONFIG_DIR=<shadowPath or homePath>` when one is set.
 *
 * A primary with an empty `homePath` sets nothing: an explicit `CLAUDE_CONFIG_DIR=~/.claude` would make Claude use
 * another `.claude.json` and keychain item than the default.
 */
export function accountEnvironment(account: LaunchAccount): { name: string; value: string }[] {
  if (account.driver === "codex") {
    if (account.shadowPath) {
      return [{ name: ACCOUNT_ENV.codex, value: account.shadowPath }, { name: "CODEX_SQLITE_HOME", value: account.homePath || DEFAULT_HOME.codex }];
    }
    return account.homePath ? [{ name: ACCOUNT_ENV.codex, value: account.homePath }] : [];
  }
  const directory = account.shadowPath || account.homePath;
  return directory ? [{ name: ACCOUNT_ENV.claude, value: directory }] : [];
}

/**
 * Why a launch's variables or secret names cannot go with `account`, or null: any of the driver's
 * ACCOUNT_CONTROLLED_ENV, compared without case, even for an account that sets no variable. Names the variable as it
 * was written, never a value. Without an account nothing is managed.
 */
export function accountEnvironmentConflict(environment: Record<string, string>, secretNames: readonly string[],
  account: LaunchAccount | null): string | null {
  if (!account) return null;
  const controlled = new Set<string>(ACCOUNT_CONTROLLED_ENV[account.driver]);
  const name = [...Object.keys(environment), ...secretNames].find(candidate => controlled.has(candidate.toUpperCase()));
  return name === undefined ? null : `${name} is managed by the account ${account.label}; remove it.`;
}

/** The driver whose accounts a launch of `software` uses: only exactly `codex` or `claude` (empty means codex). */
export function accountDriverForSoftware(software: string): AccountDriver | null {
  const command = effectiveSoftware(software);
  return command === "codex" || command === "claude" ? command : null;
}

/**
 * The Launch sheet's and template editor's hint for an alias (`codex2`, `claude-work`…) of a driver that has
 * accounts: it still launches, but without an account. Null for the exact command or a driver with no accounts.
 */
export function softwareAliasWarning(software: string, driversWithAccounts: ReadonlySet<AccountDriver>): string | null {
  const family = softwareFamily(software);
  if (family !== "codex" && family !== "claude") return null;
  if (accountDriverForSoftware(software) || !driversWithAccounts.has(family)) return null;
  const name = family === "codex" ? "Codex" : "Claude";
  return `${effectiveSoftware(software)} launches without a ${name} account: accounts apply only when Software is exactly ${family}.`;
}

/** A path as shell text: a leading `~/` stays unquoted so the shell expands it, the rest is single-quoted if needed. */
function shellPath(path: string): string {
  const word = (text: string) => SHELL_PLAIN.test(text) ? text : shSingleQuote(text);
  return path.startsWith("~/") ? `~/${word(path.slice(2))}` : word(path);
}

/**
 * The command Human runs once in a terminal to log an account in. The shell expands a leading `~/` with `$HOME`,
 * as the broker later does, so Claude's keychain item matches. Never sets `HOME`. Throws when a path is not valid.
 * A shadow's login runs after HiveMind has prepared the shadow (docs/accounts.md#logging-in).
 */
export function accountLoginCommand(spec: Pick<AccountSpec, "driver" | "homePath" | "shadowPath">): string {
  if (accountPathProblem(spec.homePath) || accountPathProblem(spec.shadowPath)) throw new Error("Account paths are not valid");
  if (spec.driver === "codex") {
    if (spec.shadowPath) {
      const dir = shellPath(spec.shadowPath);
      const home = shellPath(spec.homePath || DEFAULT_HOME.codex);
      return `mkdir -p ${dir} && CODEX_HOME=${dir} CODEX_SQLITE_HOME=${home} codex -c cli_auth_credentials_store=file login`;
    }
    return spec.homePath ? `CODEX_HOME=${shellPath(spec.homePath)} codex login` : "codex login";
  }
  const directory = spec.shadowPath || spec.homePath;
  if (!directory) return "claude auth login";
  const dir = shellPath(directory);
  return `mkdir -p ${dir} && CLAUDE_CONFIG_DIR=${dir} claude auth login`;
}

/** One quota window as the provider reports it: "5 h", "Week", "Opus (week)"… */
export const usageWindowSchema = z.object({
  /** Stable within a source: `five_hour`, `codex.primary`… */
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(ACCOUNT_LIMITS.label),
  /** Used, not remaining. */
  usedPercent: z.number().min(0).max(100),
  /** Unix ms; null when the provider gives no reset time. */
  resetsAt: z.number().int().nonnegative().nullable(),
}).strict();

/**
 * One usage read of one account, as Server.app sends it to the server. A read that failed carries `error` (at most
 * 200 characters, never a token or file contents) and the server keeps the previous windows.
 */
export const usageSnapshotSchema = z.object({
  accountId: z.string().min(1).max(64),
  /** Unix ms. */
  capturedAt: z.number().int().nonnegative(),
  source: z.enum(ACCOUNT_DRIVERS),
  plan: z.enum(["subscription", "api-key", "unknown"]),
  windows: z.array(usageWindowSchema).max(8).superRefine((windows, ctx) => {
    if (new Set(windows.map(window => window.key)).size !== windows.length) ctx.addIssue({ code: "custom", message: "a window key is used twice" });
  }),
  error: z.string().max(200).nullable(),
  /** Unix ms when a limit error was seen. Shown, not used by the policy. */
  limitErrorAt: z.number().int().nonnegative().nullable(),
}).strict();

export type UsageWindow = z.infer<typeof usageWindowSchema>;
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;

/** What the server keeps per account: the last good snapshot and the last attempt. */
export type AccountUsage = {
  accountId: string;
  snapshot: UsageSnapshot | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  limitResetAt: number | null;
  limitErrorAt: number | null;
};

/** A snapshot older than this is shown as stale and does not count as live data. */
export const USAGE_STALE_MS = 10 * 60_000;
