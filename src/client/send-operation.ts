import { sendInputSchema, validated } from "../shared/api-contract.ts";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { hiveHome } from "../server/paths.ts";
import { agentRequest, agentUploadFile, hiveUrl } from "./http.ts";
import { requestIdSchema } from "../shared/mutation.ts";
import { FILE_MAX_BYTES } from "../shared/types.ts";
import { SendJournal } from "./send-journal.ts";

type Input = { channel: string; body: string; threadId?: string | null; attachmentIds?: string[];
  eventType?: string; recipients?: string[]; traceId?: string; causeMessageId?: string; executionId?: string;
  file?: { path: string; mime: string; name: string } };
async function fileFingerprint(file: NonNullable<Input["file"]>) {
  const before = statSync(file.path);
  if (!before.isFile() || before.size > FILE_MAX_BYTES) throw new Error("Expected a bounded regular attachment file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file.path)) hash.update(chunk);
  const after = statSync(file.path);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error("Attachment changed while preparing the send");
  return [path.resolve(file.path), hash.digest("hex"), file.mime, file.name];
}
/** A stable caller key resumes the immutable send, including uploaded attachment IDs. */
export async function sendOperation(input: Input, token: string, key: string = randomUUID()) {
  validated(sendInputSchema, { body: input.body, threadId: input.threadId, attachmentIds: input.attachmentIds,
    eventType: input.eventType, recipients: input.recipients, traceId: input.traceId,
    causeMessageId: input.causeMessageId, executionId: input.executionId, requestId: key });
  requestIdSchema.parse(key);
  const scope = createHash("sha256").update(hiveUrl()).update("\0").update(token).digest("hex");
  let journal: SendJournal | undefined, nonce: string | undefined;
  try {
    const fingerprint = input.file ? await fileFingerprint(input.file) : null;
    const hash = createHash("sha256").update(JSON.stringify([input.channel, input.body, input.threadId ?? null,
      input.attachmentIds ?? [], input.eventType ?? null, [...input.recipients ?? []].sort(),
      input.traceId ?? null, input.causeMessageId ?? null, fingerprint,
      ...(input.executionId ? [input.executionId] : [])])).digest("hex");
    journal = new SendJournal(hiveHome());
    const claim = journal.claim(scope, key, hash, input.attachmentIds ?? []);
    nonce = claim.nonce;
    const ids = claim.ids;
    if (input.file && ids.length === (input.attachmentIds?.length ?? 0)) {
      const uploaded = await agentUploadFile<{ file: { id: string } }>("/api/agent/files", input.file.path, token, input.file.name, input.file.mime);
      // Do not send a different file under a key prepared for the original bytes.
      if (JSON.stringify(await fileFingerprint(input.file)) !== JSON.stringify(fingerprint))
        throw new Error("Attachment changed during upload; inspect the pending operation");
      ids.push(uploaded.file.id); journal.uploaded(scope, key, nonce, ids);
    }
    const result = await agentRequest<{ ok: boolean; seq: number; id: string }>("POST",
      `/api/agent/channels/${encodeURIComponent(input.channel)}/messages`,
      { body: input.body, threadId: input.threadId ?? null, attachmentIds: ids,
        eventType: input.eventType, recipients: input.recipients, traceId: input.traceId,
        causeMessageId: input.causeMessageId, executionId: input.executionId, requestId: key }, token);
    return { ...result, requestId: key };
  } catch (error) {
    throw new Error(`Send ${key} failed: ${error instanceof Error ? error.message : "unknown outcome"}. Retry the same input with requestId/--request-id ${key}; do not choose a new key.`, { cause: error });
  } finally {
    try { if (journal && nonce) journal.release(scope, key, nonce); }
    finally { journal?.close(); }
  }
}
