import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

/** Private durable escrow key. The instance secret rotates; queued claim tickets must survive that rotation. */
export class LauncherQueueCipher {
  private readonly key: Buffer;

  constructor(home: string, hasQueuedPayloads: boolean) {
    const file = path.join(home, "launcher-queue.key");
    if (!existsSync(file)) {
      if (hasQueuedPayloads) throw new Error("Launcher queue key is missing while commands are pending");
      const key = randomBytes(32);
      let fd: number;
      try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch { throw new Error("Cannot create private launcher queue key"); }
      try { writeSync(fd, key); } finally { closeSync(fd); }
    }
    let fd: number;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { throw new Error("Cannot read private launcher queue key"); }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))
        throw new Error("Launcher queue key must be a private 0600 file owned by this user");
      const key = readFileSync(fd);
      if (key.length !== 32) throw new Error("Launcher queue key has the wrong length");
      this.key = key;
    } finally { closeSync(fd); }
  }

  seal(value: unknown): string {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
  }

  open<T>(value: string): T {
    if (!value.startsWith("v1:")) throw new Error("Launcher queue payload has an unknown format");
    try {
      const bytes = Buffer.from(value.slice(3), "base64");
      if (bytes.length < 29) throw new Error("short payload");
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as T;
    } catch { throw new Error("Launcher queue payload authentication failed"); }
  }
}
