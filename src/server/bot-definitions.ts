import {
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
  statSync,
  mkdirSync,
  accessSync,
  constants,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hiveHome } from "./paths.ts";
import { shSingleQuote, type LaunchContext } from "../shared/launch-prompt.ts";
import { cliLaunchArgs } from "../shared/package-root.ts";
import {
  emptySettings,
  settingsSchema,
  validateSettings,
  recoverSettings,
  type ProjectBotConfiguration,
} from "../shared/bot-settings.ts";
import { HiveError, type Project } from "../shared/types.ts";
import { botCapabilitiesSchema } from '../shared/bot-capabilities.ts';
import { botToolsSchema, botToolCallSchema } from '../shared/bot-tools.ts';
import { invokeBot } from './bot-executor.ts';
const manifestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('bot'),
    capabilities: botCapabilitiesSchema,
    tools: botToolsSchema,
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    name: z.string().min(1).max(80),
    instructions: z.string().min(1),
    command: z.string().min(1),
    settings: z.string().min(1).optional(),
  })
  .strict().refine(manifest => manifest.capabilities.includes('tools') || manifest.tools.length === 0,
    'Tool declarations require the Tools capability');
const definitionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const registrySchema = z
  .array(z.object({ id: definitionId, manifest: z.string() }).strict())
  .max(20)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "Duplicate definition identity",
  );
/** Installed bot code and manifest. Project configuration does not create another identity. */
type Entry = z.infer<typeof registrySchema>[number];
export const MAX_BOT_DEFINITION_JSON_BYTES = 64 * 1024;
function json(file: string) {
  if (statSync(file).size > MAX_BOT_DEFINITION_JSON_BYTES)
    throw new Error("Bot file exceeds 64 KB");
  const content = readFileSync(file, "utf8");
  try { return JSON.parse(content); }
  catch { throw new Error("Invalid definition JSON file"); }
}

/** Only controlled validation errors are useful to remote UI/model consumers. */
export function botErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return "Invalid definition metadata or settings";
  if (error instanceof Error && !("code" in error)) return error.message;
  return "Could not access the local definition configuration";
}

function localOrigin(url: string): URL {
  const origin = new URL(url);
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
    origin.username ||
    origin.password
  )
    throw new Error("Expected a local Hivemind origin");
  if (origin.hostname === "localhost") origin.hostname = "127.0.0.1";
  return origin;
}

/** Prevent server settings and a simultaneous CLI command from overwriting each other. */
function acquireBotConfigurationLock(home: string): () => void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "bot-configurations.lock");
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid }) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Another bot update holds bot-configurations.lock. Wait and retry; after a crashed process, remove the stale lock only when no update is running.",
      );
    }
    throw error;
  }
  return () => unlinkSync(file);
}
function registeredEntries(home: string): Entry[] {
  try {
    return registrySchema.parse(json(path.join(home, "bot-definitions.json")));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
}
function entries(home: string): Entry[] {
  return registeredEntries(home);
}
function within(root: string, relative: string) {
  if (path.isAbsolute(relative))
    throw new Error("Bot paths must be package-relative");
  const resolved = realpathSync(path.resolve(root, relative));
  const rel = path.relative(root, resolved);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(".." + path.sep) ||
    path.isAbsolute(rel) ||
    !statSync(resolved).isFile()
  )
    throw new Error("Bot file must be inside its package");
  return resolved;
}
function read(
  entry: Omit<Entry, "id"> & {
    id?: string;
    home?: string;
  },
) {
  if (
    !path.isAbsolute(entry.manifest) ||
    (entry.home && !path.isAbsolute(entry.home))
  )
    throw new Error("Use absolute definition/profile paths");
  const manifestFile = realpathSync(entry.manifest);
  const manifest = manifestSchema.parse(json(manifestFile));
  if (entry.id && manifest.id !== entry.id)
    throw new Error(
      "Registered definition identity changed; register again explicitly",
    );
  const root = path.dirname(manifestFile);
  const instructions = within(root, manifest.instructions);
  if (statSync(instructions).size > 16384)
    throw new Error("Bot instructions exceed 16 KB");
  const executable = within(root, manifest.command);
  accessSync(executable, constants.X_OK);
  const command =
    shSingleQuote(executable) +
    (entry.home ? " --home " + shSingleQuote(entry.home) : "");
  const settings = manifest.settings
    ? settingsSchema.parse(json(within(root, manifest.settings)))
    : emptySettings;
  return {
    id: manifest.id,
    capabilities: manifest.capabilities,
    tools: manifest.tools,
    name: manifest.name,
    manifest: manifestFile,
    executable,
    settings,
    instructions: readFileSync(instructions, "utf8").replaceAll(
      "{{command}}",
      command,
    ),
  };
}
function saveJSON(home: string, name: string, value: unknown) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, name),
    temporary = file + "." + randomUUID() + ".next";
  const content = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > MAX_BOT_DEFINITION_JSON_BYTES)
    throw new Error("Bot registry exceeds 64 KB");
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } catch (error) {
    // A successful rename consumes the temporary file. Preserve the original
    // write/rename failure if cleanup itself is no longer possible.
    try { unlinkSync(temporary); } catch { /* absent or no longer writable */ }
    throw error;
  }
}
export function registerBotDefinition(home: string, manifest: string) {
  const release = acquireBotConfigurationLock(home);
  try {
    const definition = read({ manifest });
    const next = registeredEntries(home).filter((entry) => entry.id !== definition.id);
    next.unshift({ id: definition.id, manifest: definition.manifest });
    if (next.length > 20) throw new Error("At most 20 bots");
    saveJSON(home, "bot-definitions.json", next);
    return { id: definition.id, name: definition.name };
  } finally {
    release();
  }
}
export function removeBotDefinition(home: string, id: string) {
  const release = acquireBotConfigurationLock(home);
  try {
    saveJSON(
      home,
      "bot-definitions.json",
      registeredEntries(home).filter((entry) => entry.id !== id),
    );
  } finally {
    release();
  }
}
export function listBotDefinitions(home: string) {
  return entries(home).map((entry) => read(entry));
}
const bindingsSchema = z
  .array(
    z
      .object({
        projectId: z.string().regex(/^[A-Za-z0-9_-]+$/),
        definitionId,
        home: z.string().refine(path.isAbsolute),
        enabled: z.boolean(),
        revision: z.number().int().positive().safe(),
      })
      .strict(),
  )
  .refine(
    (items) =>
      new Set(items.map((item) => item.projectId + ":" + item.definitionId))
        .size === items.length,
    "Duplicate project definition",
  );
type Binding = z.infer<typeof bindingsSchema>[number];
function bindings(home: string): Binding[] {
  try {
    return bindingsSchema.parse(json(path.join(home, "project-bots.json")));
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
function saveBindings(home: string, value: Binding[]) {
  saveJSON(home, "project-bots.json", value);
}
// Canonicalize existing ancestors too, so symlink and '..' aliases cannot share a profile.
function canonicalProfile(profile: string): string {
  if (!path.isAbsolute(profile))
    throw new Error("Use an absolute profile path");
  const absolute = path.resolve(profile);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(
      canonicalProfile(path.dirname(absolute)),
      path.basename(absolute),
    );
  }
}
function profileHome(home: string, projectId: string, definitionId: string) {
  if (
    !/^[A-Za-z0-9_-]+$/.test(projectId) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(definitionId)
  )
    throw new Error("Invalid profile identity");
  return path.join(home, "profiles", projectId, definitionId);
}
function settingsAt(home: string) {
  const saved = json(path.join(home, "config.json"));
  if (!saved || typeof saved !== "object" || Array.isArray(saved))
    throw new Error("Invalid definition configuration");
  const { hiveUrl: _hiveUrl, ...settings } = saved;
  return settings;
}
function valuesAt(
  home: string,
  schema: NonNullable<ProjectBotConfiguration["settings"]>,
) {
  return validateSettings(schema, settingsAt(home));
}
export function projectBotConfigurations(
  home: string,
  project: Project,
): ProjectBotConfiguration[] {
  const bound = bindings(home);
  const installed = entries(home);
  const missing = bound
    .filter(
      (b) =>
        b.projectId === project.id &&
        !installed.some((e) => e.id === b.definitionId),
    )
    .map((b) => ({ id: b.definitionId, manifest: "" }));
  return [...installed, ...missing].map((entry) => {
    const b = bound.find(
      (b) => b.projectId === project.id && b.definitionId === entry.id,
    );
    const base = {
      id: entry.id,
      name: entry.id,
      home: b?.home ?? profileHome(home, project.id, entry.id),
      enabled: b?.enabled ?? false,
      configured: !!b,
      revision: b?.revision ?? 0,
      values: {},
    };
    try {
      const p = read(entry);
      const view = {
        ...base,
        capabilities: p.capabilities,
        tools: p.tools,
        name: p.name,
        settings: p.settings,
        values: recoverSettings(p.settings, {}),
      };
      if (!b) return view;
      let saved: unknown;
      try {
        saved = settingsAt(b.home);
        return { ...view, values: validateSettings(p.settings, saved) };
      } catch (error) {
        return {
          ...view,
          values: recoverSettings(p.settings, saved),
          error:
            saved === undefined
              ? "Saved settings are unreadable. Open Configure to restore them and save."
              : "Saved settings need attention: " +
                botErrorMessage(error) +
                ". Open Configure to correct them and save.",
        };
      }
    } catch {
      return {
        ...base,
        error:
          "Bot package is invalid/unavailable; inspect its local installation.",
      };
    }
  });
}
type Configure = (
  executable: string,
  profile: string,
  request: unknown,
) => Promise<void>;
export const configureBot: Configure = async (executable, profile, request) => {
  // Serialize before spawning: a bad request must never strand a child or timer.
  const input = JSON.stringify(request);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "SystemRoot", "WINDIR", "PATHEXT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["configure", "--home", profile], {
      cwd: profile,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let out = "", bytes = 0, settled = false;
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* process group already gone */ }
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); stop();
      // A detached descendant can keep the pipes open after the parent exits.
      // Reject now so callers release the shared update queue and profile lock.
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("Bot rejected configuration. Check its local CLI validation."), 15000);
    const data = (chunk: Buffer, stdout: boolean) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BOT_DEFINITION_JSON_BYTES) fail("Bot rejected configuration. Check its local CLI validation.");
      else if (stdout) out += chunk;
    };
    child.stdout.on("data", (chunk: Buffer) => data(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => data(chunk, false));
    child.stdin.on("error", () => {});
    // Configure is not a supervisor: ordinary descendants must not outlive it.
    child.on("exit", stop);
    child.on("error", () => fail("Could not run the installed definition configuration command"));
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (code !== 0) {
        // Never echo stdout/stderr, even a well-formed receipt.error: providers
        // may include credential values, authenticated URLs or environment data.
        fail("Bot rejected configuration. Check its local CLI validation.");
        return;
      }
      try {
        if (JSON.parse(out).configured !== true) throw new Error();
        settled = true;
        resolve();
      } catch { fail("Invalid definition configuration receipt"); }
    });
    child.stdin.end(input);
  });
};
// Serialize saves so stale forms cannot overwrite each other or race definition configuration.
let saves: Promise<unknown> = Promise.resolve();
let pendingSaves = 0;
function queueBotUpdate<T>(work: () => T | Promise<T>): Promise<T> {
  if (pendingSaves >= 8) return Promise.reject(new HiveError(429, "Bot updates are busy; retry after pending saves complete"));
  pendingSaves++;
  const operation = saves.catch(() => {}).then(work);
  saves = operation;
  return operation.finally(() => { pendingSaves--; });
}
export function saveProjectBotConfiguration(
  home: string,
  project: Project,
  url: string,
  id: string,
  input: unknown,
  configure: Configure = configureBot,
  adoptHome?: string,
) {
  return queueBotUpdate(async () => {
      const release = acquireBotConfigurationLock(home);
      try {
        const change = z
          .object({
            enabled: z.boolean(),
            values: z.record(z.string(), z.unknown()),
            expectedRevision: z.number().int().nonnegative().safe(),
          })
          .strict()
          .parse(input);
        const entry = entries(home).find((e) => e.id === id);
        if (!entry) throw new Error("Bot is not installed");
        const definition = read(entry);
        const values = validateSettings(definition.settings, change.values);
        const all = bindings(home),
          old = all.find(
            (b) => b.projectId === project.id && b.definitionId === id,
          );
        if ((old?.revision ?? 0) !== change.expectedRevision)
          throw new Error("Settings changed; reload before saving");
        if (adoptHome && !path.isAbsolute(adoptHome))
          throw new Error("Use an absolute profile path");
        if (
          old &&
          adoptHome &&
          canonicalProfile(old.home) !== canonicalProfile(adoptHome)
        )
          throw new Error("Project already uses another profile");
        const profile = canonicalProfile(
          old?.home ?? adoptHome ?? profileHome(home, project.id, id),
        );
        if (
          all.some(
            (b) =>
              canonicalProfile(b.home) === profile &&
              (b.projectId !== project.id || b.definitionId !== id),
          )
        )
          throw new Error("Profile already belongs to another project/definition");
        const origin = localOrigin(url);
        const config = { ...values, hiveUrl: origin.origin };
        // Reject known-oversized input before the external command can replace a valid profile.
        if (
          Buffer.byteLength(JSON.stringify(config), "utf8") >
          MAX_BOT_DEFINITION_JSON_BYTES
        )
          throw new Error(
            `Bot configuration exceeds ${MAX_BOT_DEFINITION_JSON_BYTES} UTF-8 bytes (64 KiB). Reduce the settings before saving; the definition was not run.`,
          );
        mkdirSync(profile, { recursive: true, mode: 0o700 });
        await configure(definition.executable, profile, {
          config,
          projectId: project.id,
        });
        // A successful receipt must correspond to readable, schema-valid local settings.
        valuesAt(profile, definition.settings);
        if (json(path.join(profile, "config.json")).hiveUrl !== origin.origin)
          throw new Error(
            "Bot did not retain the configured Hivemind server",
          );
        const currentEntry = entries(home).find((e) => e.id === id);
        if (!currentEntry || currentEntry.manifest !== entry.manifest)
          throw new Error("Bot registration changed; reload before saving");
        const next = {
          projectId: project.id,
          definitionId: id,
          home: profile,
          enabled: change.enabled,
          revision: (old?.revision ?? 0) + 1,
        };
        saveBindings(home, [...all.filter((b) => b !== old), next]);
        return projectBotConfigurations(home, project).find((p) => p.id === id)!;
      } finally {
        release();
      }
    });
}
export function setProjectBotAvailability(
  home: string,
  project: Project,
  id: string,
  input: unknown,
) {
  return queueBotUpdate(() => {
      const release = acquireBotConfigurationLock(home);
      try {
        const change = z
          .object({
            enabled: z.boolean(),
            expectedRevision: z.number().int().nonnegative().safe(),
          })
          .strict()
          .parse(input);
        const all = bindings(home),
          old = all.find(
            (b) => b.projectId === project.id && b.definitionId === id,
          );
        if (!old) throw new Error("Configure this project definition first");
        if (old.revision !== change.expectedRevision)
          throw new Error("Settings changed; reload before saving");
        if (change.enabled) {
          const entry = entries(home).find((e) => e.id === id);
          if (!entry) throw new Error("Bot is not installed");
          valuesAt(old.home, read(entry).settings);
        }
        const next = {
          ...old,
          enabled: change.enabled,
          revision: old.revision + 1,
        };
        saveBindings(
          home,
          all.map((b) => (b === old ? next : b)),
        );
        return projectBotConfigurations(home, project).find((p) => p.id === id);
      } finally {
        release();
      }
    });
}
export function callProjectBot(
  home: string, project: Project, origin: string, definitionId: string,
  bot: { id: string; name: string }, raw: unknown,
  humanControl = false,
  authorize: () => void = () => {},
) {
  const deadline = Date.now() + 30000;
  return queueBotUpdate(async () => {
    if (Date.now() >= deadline) throw new HiveError(504, 'Bot request expired before execution; no operation was dispatched');
    const release = acquireBotConfigurationLock(home);
    try {
      authorize(); // Recheck grants after queueing, immediately before dispatch.
      const input = botToolCallSchema.parse(raw);
      const binding = bindings(home).find(b => b.projectId === project.id && b.definitionId === definitionId);
      const entry = entries(home).find(e => e.id === definitionId);
      if (!binding || !entry) throw new HiveError(409, 'Configure this bot definition first');
      if (!binding.enabled && !(humanControl && ['status', 'stop'].includes(input.tool)))
        throw new HiveError(403, 'This bot definition is disabled');
      const definition = read(entry);
      if (!definition.capabilities.includes('tools')) throw new HiveError(403, 'This definition does not expose tools');
      const tool = definition.tools.find(t => t.name === input.tool);
      if (!tool) throw new HiveError(404, 'Unknown bot tool');
      const args = validateSettings(tool.parameters, input.arguments);
      valuesAt(binding.home, definition.settings);
      if (json(path.join(binding.home, 'config.json')).hiveUrl !== localOrigin(origin).origin)
        throw new HiveError(409, 'Bot settings point to a different Hivemind server');
      return await invokeBot(definition.executable, binding.home, {
        tool: tool.name, arguments: args, projectId: project.id, botId: bot.id, botName: bot.name,
      }, deadline - Date.now());
    } finally { release(); }
  });
}

/** Human-only provisioning. The token is delivered on stdin, never in argv, a receipt or diagnostics. */
export function connectProjectBot(home: string, project: Project, origin: string, definitionId: string,
  bot: { id: string; name: string }, token: string, authorize: () => void = () => {}) {
  const deadline = Date.now() + 30000;
  return queueBotUpdate(async () => {
    if (Date.now() >= deadline) throw new HiveError(504, 'Bot connection expired before execution; no connection was dispatched');
    const release = acquireBotConfigurationLock(home);
    try {
      authorize();
      const binding = bindings(home).find(b => b.projectId === project.id && b.definitionId === definitionId);
      const entry = entries(home).find(e => e.id === definitionId);
      if (!binding || !entry) throw new HiveError(409, 'Configure the bot definition before connecting an identity');
      const definition = read(entry);
      valuesAt(binding.home, definition.settings);
      if (json(path.join(binding.home, 'config.json')).hiveUrl !== localOrigin(origin).origin)
        throw new HiveError(409, 'Bot settings point to a different Hivemind server');
      const result = await invokeBot(definition.executable, binding.home, { tool: 'connect', arguments: {}, projectId: project.id, botId: bot.id, botName: bot.name, token }, deadline - Date.now());
      if (!result || typeof result !== 'object' || !('connected' in result) || result.connected !== true)
        throw new HiveError(502, 'Invalid connection receipt; inspect bot status before retrying');
      return { connected: true };
    } finally { release(); }
  });
}

export function launchContext(
  home: string,
  url: string,
  project?: Pick<Project, "id" | "slug">,
): LaunchContext {
  const origin = localOrigin(url);
  // Connection metadata does not depend on installed bot definitions or profiles.
  const connection: LaunchContext = {
    project,
    botDefinitions: [],
    botInstructions: "",
    hivemindMcp: {
      command: process.execPath,
      args: cliLaunchArgs(["mcp"]),
      env: {
        HIVEMIND_URL: origin.origin,
        HIVEMIND_HOME: path.join(home, "clients"),
        HIVEMIND_TOKEN: "",
      },
    },
  };
  try {
    const bound = project
      ? bindings(home).filter((b) => b.projectId === project.id && b.enabled)
      : [];
    const registered = entries(home);
    const definitions = bound.map((b) => {
      const entry = registered.find((e) => e.id === b.definitionId);
      if (!entry) throw new Error("Enabled project definition is missing");
      const p = read({ ...entry, home: b.home });
      valuesAt(b.home, p.settings);
      if (json(path.join(b.home, "config.json")).hiveUrl !== origin.origin)
        throw new Error(
          "Bot profile points to a different Hivemind server; save its settings for this server first",
        );
      return p;
    });
    return {
      ...connection,
      botDefinitions: definitions.map((p) => ({ id: p.id, name: p.name })),
      botInstructions: definitions
        .map((p) => "## Bot service: " + p.name + "\n" + p.instructions)
        .join("\n\n"),
    };
  } catch (error) {
    return {
      ...connection,
      botError: botErrorMessage(error),
    };
  }
}
export async function botsMain(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      home: { type: "string" },
      "config-home": { type: "string" },
      project: { type: "string" },
    },
  });
  const home = values.home ?? hiveHome();
  if (!path.isAbsolute(home))
    throw new Error("Use an absolute Hivemind --home");
  const [command, target] = positionals;
  if (command !== "bind" && (values.project || values["config-home"])) {
    throw new Error(
      "--project and --config-home apply only to bots bind; registration is shared across projects",
    );
  }
  if (
    command === "bind" &&
    target &&
    positionals.length === 2 &&
    values.project &&
    values["config-home"]
  ) {
    const { Hive } = await import("./hive.ts");
    if (!statSync(path.join(home, "hive.db")).isFile())
      throw new Error("Bind requires an existing Hivemind database");
    const hive = new Hive(path.join(home, "hive.db"));
    try {
      const project = hive.projects.getProjectBySlug(values.project);
      const configHome = realpathSync(values["config-home"]);
      const { hiveUrl, ...config } = json(path.join(configHome, "config.json"));
      const current = projectBotConfigurations(home, project).find(
        (p) => p.id === target,
      );
      if (!current) throw new Error("Bot is not installed");
      const result = await saveProjectBotConfiguration(
        home,
        project,
        hiveUrl,
        target,
        { enabled: true, values: config, expectedRevision: current.revision },
        configureBot,
        configHome,
      );
      console.log(
        JSON.stringify({
          id: result.id,
          project: project.slug,
          home: result.home,
          enabled: result.enabled,
          monitorStarted: false,
        }),
      );
    } finally {
      hive.close();
    }
    return;
  }
  if (
    command === "add" &&
    target &&
    positionals.length === 2 &&
    !values["config-home"] &&
    !values.project
  )
    console.log(JSON.stringify(registerBotDefinition(home, target)));
  else if (command === "remove" && target && positionals.length === 2) {
    removeBotDefinition(home, target);
    console.log(
      "Bot unregistered; its monitor is not stopped automatically.",
    );
  } else if (command === "list" && positionals.length === 1)
    console.log(
      JSON.stringify(
        listBotDefinitions(home).map(({ id, name, manifest }) => ({
          id,
          name,
          manifest,
        })),
        null,
        2,
      ),
    );
  else
    throw new Error(
      "Usage: hivemind bots add /absolute/hivemind-bot.json | list | remove ID | bind ID --project SLUG --config-home /existing/profile [--home /hive]. Configure new profiles in Project settings → Bots.",
    );
}
