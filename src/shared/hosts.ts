import { z } from "zod";

/**
 * Remote hosts (docs/remote-hosts.md): Macs on the local network, reached with SSH, where brains and workers run.
 * Hivemind Server.app keeps them (hosts.json, with the SSH destination and forwards) and tells the server only the
 * catalog below, over the signed launcher channel. HivemindKit's HostCatalogEntry sends the same three keys.
 */

/** `label` in characters, as Server.app counts them; `hosts` in one catalog. */
export const HOST_LIMITS = { label: 80, hosts: 16 } as const;

/** Control characters (C0, DEL, C1) and lone surrogates. */
const CONTROL = /\p{Cc}|\p{Cs}/u;

/** One host as the server holds it: what the UI may show, and whether it can take launches now. */
export const hostCatalogEntrySchema = z.object({
  /** A lowercase UUID, stable for the life of the host. */
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  label: z.string().max(HOST_LIMITS.label).refine(label => label.trim().length > 0 && !CONTROL.test(label)),
  /** The host connection is up and the host's remote runtime is this server's. */
  online: z.boolean(),
}).strict();

/** `PUT /api/launcher/hosts`: the whole catalog, which replaces the one the server held. */
export const hostCatalogSchema = z.object({
  hosts: z.array(hostCatalogEntrySchema).max(HOST_LIMITS.hosts).refine(hosts => new Set(hosts.map(host => host.id)).size === hosts.length),
}).strict();

export type HostCatalogEntry = z.infer<typeof hostCatalogEntrySchema>;
