import { closeSync, constants, fchmodSync, openSync } from "node:fs";

/** Set permissions before SQLite creates WAL/SHM siblings. Never follow a final symlink. */
export function preparePrivateDatabase(file: string): void {
  if (file === ":memory:") return;
  for (const suffix of ["", "-wal", "-shm"]) {
    let fd: number;
    try {
      fd = openSync(file + suffix, constants.O_RDWR | constants.O_NOFOLLOW | (suffix ? 0 : constants.O_CREAT), 0o600);
    } catch (error) {
      if (suffix && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
  }
}
