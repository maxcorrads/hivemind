import type { WebSocket } from "ws";
import { websocketOverloaded } from "../shared/realtime.ts";

type Client = Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "close" | "terminate" | "ping">;
const OPEN = 1;
const CLOSING = 2;

/** Failure of one client cannot interrupt broadcasts to healthy clients. */
export function sendRealtime(client: Client, data: string, bytes = Buffer.byteLength(data)): void {
  if (client.readyState !== OPEN) return;
  try {
    if (websocketOverloaded(client.bufferedAmount, bytes)) {
      client.close(1013, "client too slow; reconnect to resync");
      return;
    }
    client.send(data, (error) => { if (error) client.terminate(); });
  } catch { client.terminate(); }
}

/** A missing pong or a stuck close handshake is reclaimed on the next tick. */
export function heartbeatClients<T extends Client>(clients: Iterable<T>, responsive: WeakSet<T>): void {
  for (const client of clients) {
    if (client.readyState === CLOSING) { client.terminate(); continue; }
    if (client.readyState !== OPEN) continue;
    if (!responsive.has(client)) { client.terminate(); continue; }
    responsive.delete(client);
    try { client.ping(); } catch { client.terminate(); }
  }
}
