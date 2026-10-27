import { z } from "zod";
import { DEFAULT_AGENT_PORT } from "./types.ts";

/**
 * Remote hosts (docs/remote-hosts.md): Macs on the local network, reached with SSH, where brains and workers run.
 * Hivemind Server.app keeps them (hosts.json, with the SSH destination and forwards) and tells the server only the
 * catalog below, over the signed launcher channel. HivemindKit's HostCatalogEntry sends the same three keys.
 */

/** `label` in characters, as Server.app counts them; `hosts` in one catalog. */
export const HOST_LIMITS = { label: 80, hosts: 16 } as const;

/** Control characters (C0, DEL, C1) and lone surrogates. */
const CONTROL = /\p{Cc}|\p{Cs}/u;

/** A host's id: a lowercase UUID, stable for the life of the host. */
export const HOST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const hostIdSchema = z.string().regex(HOST_ID_PATTERN);

/** One host as the server holds it: what the UI may show, and whether it can take launches now. */
export const hostCatalogEntrySchema = z.object({
  id: hostIdSchema,
  label: z.string().max(HOST_LIMITS.label).refine(label => label.trim().length > 0 && !CONTROL.test(label)),
  /** The host connection is up and the host's remote runtime is this server's. */
  online: z.boolean(),
}).strict();

/** `PUT /api/launcher/hosts`: the whole catalog, which replaces the one the server held. */
export const hostCatalogSchema = z.object({
  hosts: z.array(hostCatalogEntrySchema).max(HOST_LIMITS.hosts).refine(hosts => new Set(hosts.map(host => host.id)).size === hosts.length),
}).strict();

export type HostCatalogEntry = z.infer<typeof hostCatalogEntrySchema>;

/**
 * The agent listener's port as the host connection forwards it on every host (docs/remote-hosts.md#host-connection):
 * the same 7422 as on the control Mac, so a remote agent's HIVEMIND_URL is `http://127.0.0.1:7422`.
 */
export const REMOTE_AGENT_PORT = DEFAULT_AGENT_PORT;

/** Hivemind's folder on a host, relative to its home; the remote runtime is under `remote/<version>` (RemoteRuntime.folder). */
export const REMOTE_SUPPORT_FOLDER = "Library/Application Support/Hivemind";

/** What may name a runtime folder: RemoteRuntime's rule for the server package's version. */
const RUNTIME_VERSION = /^[A-Za-z0-9+][A-Za-z0-9.+-]{0,63}$/;

/**
 * The Hivemind MCP of a launch on a host (docs/remote-hosts.md#remote-runtime): the remote runtime's own Node.js and
 * `server/bin/hivemind.mjs mcp` of this server's `version`, which Server.app installs there, talking to the agent
 * forward. The server does not know the host's home, so `/bin/sh -c` finds the runtime under `$HOME` there; the script
 * holds nothing but those paths. The MCP keeps its files in the host's `clients` folder, as `<home>/clients` here.
 */
export function remoteHivemindMcp(version: string): { command: string; args: string[]; env: Record<string, string> } {
  if (!RUNTIME_VERSION.test(version)) throw new Error("This server's version cannot name a remote runtime");
  const runtime = `"$support/remote/${version}"`;
  return {
    command: "/bin/sh",
    args: ["-c", `support="$HOME/${REMOTE_SUPPORT_FOLDER}"; HIVEMIND_HOME="$support/clients" exec ${runtime}/node ` +
      `${runtime}/server/bin/hivemind.mjs mcp`],
    env: { HIVEMIND_URL: `http://127.0.0.1:${REMOTE_AGENT_PORT}`, HIVEMIND_TOKEN: "" },
  };
}
