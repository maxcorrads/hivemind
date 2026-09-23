import { HiveError, type Agent, type AttachmentMeta } from "../../shared/types.ts";
import { assertAllowedMime, commitUpload, openBlob, removeOrphanBlobs, removeUploadTemp, streamUpload } from "../files.ts";
import type { UploadBudget } from "../upload-budget.ts";
import type { ChannelAccess, Core, MessageReader } from "./ports.ts";
import { now } from "./rows.ts";

export type FileServiceDeps = Core & {
  /** The hive directory; blobs live under it. */
  readonly home: string;
  readonly uploads: UploadBudget;
  readonly reader: MessageReader;
  readonly channels: ChannelAccess;
};

type AttachmentRow = { id: string; message_id: string | null; name: string; mime: string; bytes: number; sha256: string };

/** Uploads, attachment metadata and access, and blob garbage collection. */
export class FileService {
  constructor(private readonly deps: FileServiceDeps) {}

  private get db() { return this.deps.storage.db; }

  async createFile(
    actor: Agent,
    input: { name: string; mime: string; body: ReadableStream<Uint8Array> | null; signal?: AbortSignal; declaredBytes?: number; authorize?: () => Agent },
  ): Promise<AttachmentMeta> {
    const { home, uploads, storage } = this.deps;
    assertAllowedMime(input.mime);
    if (typeof input.name !== "string" || !input.name.length || input.name.length > 180) throw new HiveError(400, "Invalid file name");
    input.signal?.throwIfAborted();
    const lease = uploads.acquire(actor.id, input.declaredBytes);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new HiveError(408, "Upload deadline exceeded")), uploads.limits.deadlineMs);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
    try {
      const uploaded = await streamUpload(input.body, input.mime, home, signal, input.declaredBytes);
      try {
        signal.throwIfAborted();
        return storage.transaction(() => {
          lease.require(uploaded.bytes);
          if (input.authorize && input.authorize().id !== actor.id) throw new HiveError(403, "Upload actor changed");
          if (input.declaredBytes !== undefined && uploaded.bytes !== input.declaredBytes) throw new HiveError(400, "Upload length mismatch");
          commitUpload(uploaded.tmp, uploaded.sha256, home);
          const id = crypto.randomUUID();
          this.db.prepare(
            `INSERT INTO attachments (id, message_id, name, mime, bytes, sha256, created_by, created_at)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
          ).run(id, input.name, input.mime, uploaded.bytes, uploaded.sha256, actor.id, now());
          return { id, name: input.name, mime: input.mime, bytes: uploaded.bytes };
        });
      } finally { removeUploadTemp(uploaded.tmp); }
    } catch (error) {
      if (deadline.signal.aborted) throw deadline.signal.reason;
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw new HiveError(507, "Upload disk is full");
      throw error;
    } finally { clearTimeout(timer); lease.release(); }
  }

  async createFileFromBytes(
    actor: Agent,
    input: { name: string; mime: string; bytes: Uint8Array },
  ): Promise<AttachmentMeta> {
    const { Readable } = await import("node:stream");
    const stream = Readable.toWeb(Readable.from(Buffer.from(input.bytes)));
    return this.createFile(actor, { name: input.name, mime: input.mime, body: stream as ReadableStream<Uint8Array>, declaredBytes: input.bytes.byteLength });
  }

  /** Every ID must be an unsent upload of `actor`; checked before a send mutates anything. */
  validateAttachments(actor: Agent, ids: string[]) {
    if (new Set(ids).size !== ids.length) throw new HiveError(400, "Duplicate attachment");
    for (const id of ids) {
      const row = this.db.prepare("SELECT id, message_id, created_by FROM attachments WHERE id = ?").get(id) as
        | { id: string; message_id: string | null; created_by: string }
        | undefined;
      if (!row) throw new HiveError(404, "Attachment not found");
      if (row.created_by !== actor.id) throw new HiveError(403, "Attachment is not yours");
      if (row.message_id) throw new HiveError(409, "Attachment already sent");
    }
  }

  bindAttachments(messageId: string, ids: string[]) {
    const bind = this.db.prepare("UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL");
    for (const id of ids) {
      const result = bind.run(messageId, id);
      if (result.changes !== 1) throw new HiveError(409, "Attachment already sent");
    }
  }

  getAttachment(actor: Agent, id: string): { meta: AttachmentMeta; sha256: string; channelId: string | null } {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
    if (!row) throw new HiveError(404, "Attachment not found");
    if (row.message_id) {
      const { reader, channels } = this.deps;
      const msg = reader.getMessageById(row.message_id);
      const ch = channels.getChannel(msg.channelId);
      if (!channels.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot access file");
      return { meta: { id: row.id, name: row.name, mime: row.mime, bytes: row.bytes }, sha256: row.sha256, channelId: ch.id };
    }
    if (row.message_id === null) {
      const owner = this.db.prepare("SELECT created_by FROM attachments WHERE id = ?").get(id) as { created_by: string };
      if (owner.created_by !== actor.id && actor.role !== "human") throw new HiveError(403, "Cannot access file");
    }
    return { meta: { id: row.id, name: row.name, mime: row.mime, bytes: row.bytes }, sha256: row.sha256, channelId: null };
  }

  openAttachment(actor: Agent, id: string) {
    const att = this.getAttachment(actor, id);
    return { ...att, ...openBlob(att.sha256, this.deps.home) };
  }

  /** Drops an agent's never-sent uploads (their blobs go on the next sweep). */
  deleteUnsentBy(agentId: string) {
    this.db.prepare("DELETE FROM attachments WHERE created_by = ? AND message_id IS NULL").run(agentId);
  }

  /** Drops one upload if it was never sent (a failed inbound transfer). */
  discardUnsent(id: string) {
    this.db.prepare("DELETE FROM attachments WHERE id = ? AND message_id IS NULL").run(id);
  }

  collectUnusedBlobs(): number {
    // Acquire the same cross-process writer lock as publication BEFORE reading the live set.
    return this.deps.storage.transaction(() => {
      const used = new Set(
        (this.db.prepare("SELECT DISTINCT sha256 AS h FROM attachments").all() as { h: string }[]).map((r) => r.h),
      );
      return removeOrphanBlobs(used, this.deps.home);
    });
  }

  gcFiles(): { attachments: number; blobs: number } {
    // Commit metadata removal first. A failed COMMIT must never resurrect references to unlinked blobs.
    const attachments = this.deps.storage.transaction(() => Number(this.db.prepare(
      "DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?",
    ).run(now() - 86_400_000).changes));
    return { attachments, blobs: this.collectUnusedBlobs() };
  }
}
