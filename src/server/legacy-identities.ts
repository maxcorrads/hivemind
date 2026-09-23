import { lstatSync, rmSync } from "node:fs";
import path from "node:path";

/** Identity folders written before agents resumed by name (#144). Nothing reads them anymore. */
export const LEGACY_IDENTITY_DIRS = ["identities", "identities-v2"] as const;

/**
 * Removes the legacy identity folders directly inside the hive home. Idempotent:
 * once they are gone this is two failed lstat calls. Only real directories are
 * removed; a symlink (or any other entry) under those names is left untouched so
 * the cleanup can never reach outside the hive home. Recursive removal unlinks
 * nested symlinks without following them. Failures never block startup.
 */
export function removeLegacyIdentityDirs(home: string): string[] {
  const removed: string[] = [];
  for (const name of LEGACY_IDENTITY_DIRS) {
    const target = path.join(home, name);
    try {
      if (!lstatSync(target).isDirectory()) continue;
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch {
      /* missing or not removable: best-effort legacy cleanup */
    }
  }
  return removed;
}
