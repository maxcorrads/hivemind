import { validated } from "../shared/api-contract.ts";
import { hostCatalogSchema, type HostCatalogEntry } from "../shared/hosts.ts";

/**
 * The remote hosts Hivemind Server.app connects to (docs/remote-hosts.md#hosts): id, label and online, in Server.app's
 * order. Server.app sends the whole catalog over the launcher channel when it changes and to every new server, so the
 * server holds it in memory only: it is Server.app's state, and empty until Server.app has a host. The SSH destination
 * and the forwards never reach the server.
 */
export class HostCatalog {
  private hosts: readonly HostCatalogEntry[] = [];

  /** Replaces the catalog with `raw`, a `PUT /api/launcher/hosts` body; refused whole when it does not validate. */
  replace(raw: unknown): void {
    this.hosts = validated(hostCatalogSchema, raw).hosts.map(host => ({ ...host }));
  }

  list(): HostCatalogEntry[] {
    return this.hosts.map(host => ({ ...host }));
  }

  get(id: string): HostCatalogEntry | undefined {
    const host = this.hosts.find(entry => entry.id === id);
    return host && { ...host };
  }
}
