import { requestIdSchema } from "../src/shared/mutation.ts";
import type { AdaptiveLockScope, AdaptiveRoutingMode } from "../src/shared/adaptive-topology.ts";

type Pending = { channel: string; body: string; root: string | null; files: File[];
  routing: AdaptiveRoutingMode; lockScope: AdaptiveLockScope;
  ids: string[]; key: string; at: number; running?: Promise<unknown> };
export function createSendOperations<T>(upload: (file: File) => Promise<{ id: string }>,
  send: (channel: string, body: string, root: string | null, ids: string[], requestId: string,
    routing: AdaptiveRoutingMode, lockScope: AdaptiveLockScope) => Promise<T>) {
  const pending: Pending[] = [];
  return (channel: string, body: string, root: string | null, files: File[] = [],
    routing: AdaptiveRoutingMode = "auto", lockScope: AdaptiveLockScope = "none"): Promise<T> => {
    let operation = pending.find(p => p.channel === channel && p.body === body && p.root === root &&
      p.routing === routing && p.lockScope === lockScope &&
      p.files.length === files.length && p.files.every((file, i) => file === files[i]));
    if (operation && Date.now() - operation.at >= 86_400_000) return Promise.reject(new Error("Send retry window expired; inspect history before starting a new operation"));
    if (operation?.running) return operation.running as Promise<T>;
    if (!operation) {
      if (pending.length >= 32) return Promise.reject(new Error("Too many uncertain sends; resolve them before sending more"));
      operation = { channel, body, root, files: [...files], routing, lockScope, ids: [], key: crypto.randomUUID(), at: Date.now() };
      requestIdSchema.parse(operation.key);
      pending.push(operation);
    }
    const current = operation;
    current.running = (async () => {
      for (let i = current.ids.length; i < current.files.length; i++) current.ids.push((await upload(current.files[i]!)).id);
      const result = await send(channel, body, root, [...current.ids], current.key, current.routing, current.lockScope);
      pending.splice(pending.indexOf(current), 1);
      return result;
    })().finally(() => { current.running = undefined; });
    return current.running as Promise<T>;
  };
}
