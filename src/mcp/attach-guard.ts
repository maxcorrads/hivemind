import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { hiveHome } from "../server/paths.ts";

/**
 * Credential stores under the home directory that `attach` never uploads (#218). A prompt-injected agent
 * could otherwise post them to a channel, and from there they may leave the machine (e.g. via Telegram).
 * Everything outside this denylist stays attachable.
 */
const SENSITIVE_HOME_DIRS = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".hivemind", ".kube", ".docker", ".azure",
  ".config/gh", ".password-store"];
const SENSITIVE_HOME_FILES = [".netrc", ".npmrc", ".pypirc", ".git-credentials", ".pgpass"];
/** File names that hold secrets wherever they live: dotenv files and private keys (SSH `id_*` without `.pub`, PEM/PKCS). */
const SENSITIVE_NAMES = [/^\.env(?:\..*)?$/i, /^id_[a-z0-9_-]+$/i, /\.(?:pem|key|p12|pfx|jks|keystore|ppk)$/i];

export type AttachRoots = { home: string; hiveHome: string };

function canonical(target: string): string {
  try { return realpathSync.native(target); } catch { return path.resolve(target); }
}
// Case-insensitive: macOS and Windows file systems resolve ~/.SSH to ~/.ssh.
const within = (target: string, root: string) => {
  const relative = path.relative(root.toLowerCase(), target.toLowerCase());
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

function sensitiveReason(target: string, roots: AttachRoots): string | undefined {
  const name = path.basename(target);
  if (SENSITIVE_NAMES.some(pattern => pattern.test(name))) return `${name} looks like a secret (dotenv file or private key)`;
  const homes = [...new Set([roots.home, canonical(roots.home)])];
  for (const home of homes) {
    for (const dir of SENSITIVE_HOME_DIRS) if (within(target, path.join(home, dir))) return `it is inside ~/${dir}`;
    for (const file of SENSITIVE_HOME_FILES) if (within(target, path.join(home, file))) return `it is ~/${file}`;
  }
  for (const hive of new Set([roots.hiveHome, canonical(roots.hiveHome)]))
    if (within(target, hive)) return "it is inside the Hivemind data directory";
  return undefined;
}

/**
 * Resolves `filePath` for upload and refuses sensitive locations. Both the path as given and its real path
 * (every symlink resolved) are checked, so a link cannot smuggle a key out and a key cannot hide behind a
 * harmless name. Returns the real path, which is what gets uploaded.
 */
export function attachablePath(filePath: string, roots: AttachRoots = { home: homedir(), hiveHome: hiveHome() }): string {
  const given = path.resolve(filePath);
  if (!existsSync(given)) throw new Error(`File not found: ${filePath}`);
  const real = realpathSync.native(given);
  const reason = sensitiveReason(given, roots) ?? sensitiveReason(real, roots);
  if (reason) throw new Error(`attach refused ${filePath}: ${reason}. Credential stores, dotenv files and private keys are never uploaded; ask Human if this file must be shared.`);
  if (!statSync(real).isFile()) throw new Error(`Not a regular file: ${filePath}`);
  return real;
}
