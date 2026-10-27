import { useEffect, useState } from "react";
import type { HostCatalogEntry } from "../src/shared/hosts.ts";
import { api } from "./api.ts";

// The remote hosts' labels for the terminal views (docs/remote-hosts.md#sessions-and-terminals): a session on a host
// carries its host id, and the server's catalog names it. The catalog is asked for only once some session has a host,
// so a hive without hosts asks for nothing, as before hosts.

/** The server's host catalog once `wanted` (some session runs on a host); empty before, and when it cannot be read. */
export function useHosts(wanted: boolean): HostCatalogEntry[] {
  const [hosts, setHosts] = useState<HostCatalogEntry[]>([]);
  useEffect(() => {
    if (!wanted) return;
    let active = true;
    api.hosts().then(view => { if (active) setHosts(view.hosts); }).catch(() => undefined);
    return () => { active = false; };
  }, [wanted]);
  return hosts;
}

/** What the UI calls the host `id`: its label, "a remote host" while the catalog does not name it, null for this Mac. */
export function hostLabel(hosts: readonly HostCatalogEntry[], id: string | undefined | null): string | null {
  if (!id) return null;
  return hosts.find(item => item.id === id)?.label ?? "a remote host";
}
