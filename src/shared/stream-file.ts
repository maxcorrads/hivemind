import { open, unlink, type FileHandle } from 'node:fs/promises';

/** Write a single bounded chunk at a time. Producer cancellation is best effort:
 * its promise must not hold a file descriptor or admission reservation forever. */
export async function streamToTemporaryFile(body: ReadableStream<Uint8Array>, destination: string,
  maximum: number, signal?: AbortSignal, onChunk?: (chunk: Uint8Array) => void): Promise<number> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid stream byte budget");
  signal?.throwIfAborted();
  const reader = body.getReader();
  let file: FileHandle | undefined, failed = true, bytes = 0, emptyChunks = 0;
  let rejectStop!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  stopped.catch(() => undefined);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const stop = () => { rejectStop(signal?.reason ?? new DOMException('Aborted', 'AbortError')); cancel(); };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try {
    file = await open(destination, 'wx', 0o600);
    for (;;) {
      signal?.throwIfAborted();
      const next = await Promise.race([reader.read(), stopped]);
      signal?.throwIfAborted();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new Error('Invalid binary stream chunk');
      if (next.value.byteLength === 0) { if (++emptyChunks > 32) throw new Error("Stream made no progress"); continue; }
      emptyChunks = 0;
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new Error('Stream exceeds its byte budget');
      for (let start = 0; start < next.value.byteLength; start += 64 * 1024) {
        // Own a small immutable-to-the-producer slice so its hash always describes
        // the bytes actually written, even for a reused/custom producer buffer.
        const chunk = Buffer.from(next.value.subarray(start, start + 64 * 1024));
        onChunk?.(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          signal?.throwIfAborted();
          const written = await file.write(chunk, offset, chunk.byteLength - offset);
          if (written.bytesWritten === 0) throw new Error('File write made no progress');
          offset += written.bytesWritten;
        }
      }
    }
    if (bytes === 0) throw new Error('Empty stream');
    await file.close(); file = undefined; failed = false;
    return bytes;
  } finally {
    signal?.removeEventListener('abort', stop);
    if (failed) cancel();
    try { reader.releaseLock(); } catch { /* cancellation has already detached this read */ }
    if (file) {
      try { await file.close(); }
      finally { await unlink(destination).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
    }
  }
}
