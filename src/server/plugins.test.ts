import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readFileSync,
  existsSync,
  statSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  registerPlugin,
  listPlugins,
  removePlugin,
  launchContext,
  projectPlugins,
  saveProjectPlugin,
  configurePlugin,
  setProjectPluginAvailability,
  MAX_PLUGIN_JSON_BYTES,
} from "./plugins.ts";
import {
  settingsSchema,
  validateSettings,
  recoverSettings,
} from "../shared/plugin-settings.ts";
import {
  buildLaunchBlock,
  buildLaunchPrompt,
  projectLaunchTools,
  ADOPT_UNTRUSTED,
} from "../shared/launch-prompt.ts";
import { Hive } from "./hive.ts";
import { createApp } from "./app.ts";
function setup(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-plugins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = path.join(dir, "package with ' quote"),
    home = path.join(dir, "hive");
  mkdirSync(pkg);
  mkdirSync(home);
  const manifest = path.join(pkg, "hivemind-plugin.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      id: "invented-source",
      name: "Invented Source",
      instructions: "TOOLS.md",
      settings: "settings.json",
      command: "tool",
    }),
  );
  writeFileSync(
    path.join(pkg, "settings.json"),
    JSON.stringify({
      version: 1,
      fields: [
        { key: "host", label: "Host", type: "string", required: true },
        {
          key: "interval",
          label: "Interval",
          type: "integer",
          default: 300,
          minimum: 60,
        },
      ],
    }),
  );
  writeFileSync(
    path.join(pkg, "TOOLS.md"),
    "Use {{command}} follow URL --channel ID only when asked.\nPreserve separate lines.",
  );
  writeFileSync(
    path.join(pkg, "tool"),
    `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');if(process.argv[2]!=='configure')process.exit(3);const home=process.argv[4];let text='';process.stdin.on('data',s=>text+=s);process.stdin.on('end',()=>{const r=JSON.parse(text);fs.mkdirSync(home,{recursive:true});fs.writeFileSync(path.join(home,'config.json'),JSON.stringify(r.config));console.log(JSON.stringify({configured:true}));});\n`,
    { mode: 0o700 },
  );
  return { dir, pkg, home, manifest };
}
const base = {
  software: "claude-company",
  workspacePath: null,
  cdWorktree: false,
  projectSlug: "example",
  passProject: true,
  role: "brain" as const,
  adoptUntrusted: true,
};
test("registration is explicit, package-relative, idempotent and never executes the plugin", (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  registerPlugin(f.home, f.manifest);
  assert.equal(listPlugins(f.home).length, 1);
  assert.match(listPlugins(f.home)[0]!.instructions, /follow URL/);
  assert.equal(
    readFileSync(path.join(f.home, "plugins.json"), "utf8").includes("Use "),
    false,
  );
  removePlugin(f.home, "invented-source");
  assert.equal(listPlugins(f.home).length, 0);
});
test("path escape, symlink escape, bad manifest and missing registered plugin are visible errors", (t) => {
  const f = setup(t);
  writeFileSync(path.join(f.dir, "outside.md"), "outside");
  symlinkSync(path.join(f.dir, "outside.md"), path.join(f.pkg, "escape.md"));
  for (const instructions of ["../outside.md", "escape.md"]) {
    writeFileSync(
      f.manifest,
      JSON.stringify({
        version: 1,
        id: "invented-source",
        name: "X",
        instructions,
        command: "tool",
      }),
    );
    assert.throws(() => registerPlugin(f.home, f.manifest), /inside/);
  }
  writeFileSync(
    f.manifest,
    JSON.stringify({
      version: 1,
      id: "invented-source",
      name: "X",
      instructions: "TOOLS.md",
      command: "tool",
    }),
  );
  registerPlugin(f.home, f.manifest);
  rmSync(path.join(f.pkg, "TOOLS.md"));
  assert.throws(() => listPlugins(f.home));
});
test("launch instructions apply to brains, survive quoting, and MCP is bound to this hive without overriding corporate MCP", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const project = hive.createProject(hive.getAgent("human"), {
    name: "Example",
    slug: "example",
  });
  await saveProjectPlugin(
    f.home,
    project,
    "http://127.0.0.1:12345",
    "invented-source",
    { enabled: true, values: { host: "example.invalid" }, expectedRevision: 0 },
    configurePlugin,
    path.join(f.dir, "profile ' quoted"),
  );
  const context = projectLaunchTools(
    launchContext(f.home, "http://127.0.0.1:12345", project),
    project,
    "brain",
  );
  const command = buildLaunchBlock({ ...base, ...context });
  assert.match(command, /--mcp-config/);
  assert.ok(!command.includes("--strict-mcp-config"));
  assert.ok(!command.includes("skip-permissions"));
  assert.match(
    buildLaunchPrompt({ ...base, ...context }),
    /Installed plugin: Invented Source/,
  );
  assert.ok(
    !buildLaunchPrompt({
      ...base,
      ...context,
      role: "worker",
      seniority: "senior",
    }).includes("Invented Source"),
  );
  const shell =
    "function claude-company() { " +
    JSON.stringify(process.execPath) +
    " -e " +
    JSON.stringify("console.log(JSON.stringify(process.argv.slice(1)))") +
    ' -- "$@"; }\n' +
    command;
  const result = spawnSync("/bin/bash", ["-c", shell], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(result.stdout);
  const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  assert.deepEqual(args.slice(0, -1), [
    "--mcp-config",
    JSON.stringify(mcp),
    "--",
  ]);
  assert.equal(args.at(-1), buildLaunchPrompt({ ...base, ...context }));
  assert.equal(
    mcp.mcpServers.hivemind.env.HIVEMIND_URL,
    "http://127.0.0.1:12345",
  );
  assert.equal(mcp.mcpServers.hivemind.env.HIVEMIND_TOKEN, "");
  assert.match(args.at(-1), /Preserve separate lines/);
});
test("HTTP launch context exposes only generic installed instructions and exact local MCP binding", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const response = await createApp(hive).request(
    "http://127.0.0.1:23456/api/ui/launch-context",
  );
  assert.equal(response.status, 200);
  const context = (await response.json()) as any;
  assert.equal(context.plugins.length, 0);
  assert.equal(context.hivemindMcp.env.HIVEMIND_URL, "http://127.0.0.1:23456");
  const view = await createApp(hive).request(
    "/api/ui/projects/chapter/plugins",
  );
  assert.equal(view.status, 200);
  const plugins = ((await view.json()) as any).plugins;
  assert.equal(plugins[0].configured, false);
  assert.equal(plugins[0].enabled, false);
  assert.equal(hive.listAgents().filter((a) => a.role === "bot").length, 0);
});
test("project settings round trip through local configure; profiles and launch instructions are isolated", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const a = hive.getProjectBySlug("chapter"),
    b = hive.createProject(hive.getAgent("human"), {
      name: "Example",
      slug: "example",
    });
  const app = createApp(hive),
    url = "http://127.0.0.1:23456";
  const put = (
    slug: string,
    values: any,
    expectedRevision: number,
    enabled = true,
  ) =>
    app.request(url + "/api/ui/projects/" + slug + "/plugins/invented-source", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values, expectedRevision, enabled }),
    });
  const before = projectPlugins(f.home, a)[0]!;
  assert.equal(before.configured, false);
  assert.equal(before.values.interval, 300);
  assert.equal((await put(a.slug, { host: "a.invalid" }, 0)).status, 200);
  assert.equal((await put(b.slug, { host: "b.invalid" }, 0)).status, 200);
  const pa = projectPlugins(f.home, a)[0]!,
    pb = projectPlugins(f.home, b)[0]!;
  assert.notEqual(pa.home, pb.home);
  assert.equal(pa.values.host, "a.invalid");
  assert.equal(pb.values.host, "b.invalid");
  for (const p of [a, b]) {
    const ctx = (await (
      await app.request(url + "/api/ui/launch-context?project=" + p.slug)
    ).json()) as any;
    assert.equal(ctx.project.id, p.id);
    assert.equal(ctx.plugins.length, 1);
    assert.ok(
      ctx.pluginInstructions.includes(projectPlugins(f.home, p)[0]!.home),
    );
    const other = p.id === a.id ? pb : pa;
    assert.ok(!ctx.pluginInstructions.includes(other.home));
    assert.throws(
      () =>
        buildLaunchPrompt({
          ...base,
          ...ctx,
          pluginProject: p.slug,
          projectSlug: "wrong",
        }),
      /matching launch project/,
    );
  }
  assert.equal(
    (await put(a.slug, { host: "overwrite.invalid" }, 0)).status,
    400,
  );
  assert.equal(
    (await put(a.slug, { host: "a.invalid", unknown: true }, 1)).status,
    400,
  );
  assert.equal(
    (await put(a.slug, { host: "a.invalid" }, 1, false)).status,
    200,
  );
  assert.equal(launchContext(f.home, url, a).plugins.length, 0);
  assert.equal(launchContext(f.home, url, b).plugins.length, 1);
  assert.equal(launchContext(f.home, url).plugins.length, 0);
  assert.equal(hive.listAgents().filter((x) => x.role === "bot").length, 0);
  assert.equal(
    (await app.request(url + "/api/ui/launch-context?project=missing")).status,
    404,
  );
});
test("HTTP load and unchanged save retain exact list values in the plugin profile", async (t) => {
  const f = setup(t);
  writeFileSync(path.join(f.pkg, "settings.json"), JSON.stringify({
    version: 1,
    fields: [
      { key: "free", label: "Free", type: "strings" },
      { key: "choices", label: "Choices", type: "strings", choices: [" padded ", "", "ordinary"] },
      { key: "empty", label: "Empty", type: "strings", minLength: 1 },
      { key: "emptyEntry", label: "Empty entry", type: "strings" },
      { key: "unset", label: "Unset", type: "strings" },
    ],
  }));
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const project = hive.getProjectBySlug("chapter");
  const app = createApp(hive);
  const url = "http://127.0.0.1:23456";
  const endpoint = url + `/api/ui/projects/${project.slug}/plugins`;
  const values = {
    free: ["  significant whitespace  ", "", "ordinary", "\t", "line\nbreak", "\r", "ordinary"],
    choices: [" padded ", "", "ordinary"],
    empty: [],
    emptyEntry: [""],
  };
  const save = (input: unknown, expectedRevision: number) => app.request(endpoint + "/invented-source", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: input, expectedRevision, enabled: true }),
  });
  assert.equal((await save(values, 0)).status, 200);
  const loaded = await (await app.request(endpoint)).json() as { plugins: Array<{
    values: typeof values; revision: number; home: string;
  }> };
  const view = loaded.plugins[0]!;
  assert.deepEqual(view.values, values);
  const configFile = path.join(view.home, "config.json");
  const before = readFileSync(configFile, "utf8");
  const saved = await save(view.values, view.revision);
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json() as { plugin: { values: unknown } }).plugin.values, values);
  assert.equal(readFileSync(configFile, "utf8"), before);
  assert.deepEqual(projectPlugins(f.home, project)[0]!.values, values);
});

test("schema rejects unknown fields, duplicate keys, reserved keys and invalid values", () => {
  assert.throws(() =>
    settingsSchema.parse({
      version: 1,
      fields: [{ key: "hiveUrl", label: "URL", type: "string" }],
    }),
  );
  const field = {
    key: "count",
    label: "Count",
    type: "integer",
    minimum: 1,
    maximum: 10,
    required: true,
  };
  assert.throws(() =>
    settingsSchema.parse({ version: 1, fields: [field, field] }),
  );
  const schema = settingsSchema.parse({
    version: 1,
    fields: [
      field,
      {
        key: "types",
        label: "Types",
        type: "strings",
        choices: ["A", "B"],
        default: ["A"],
      },
    ],
  });
  for (const input of [
    {},
    { count: 1.5 },
    { count: 11 },
    { count: 2, x: 3 },
    { count: 2, types: ["C"] },
  ])
    assert.throws(() => validateSettings(schema, input));
  assert.deepEqual(validateSettings(schema, { count: 2 }), {
    count: 2,
    types: ["A"],
  });
});
test("configure failure does not enable a profile, and an adopted profile cannot be shared across projects", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const a = hive.getProjectBySlug("chapter"),
    b = hive.createProject(hive.getAgent("human"), {
      name: "Example",
      slug: "example",
    }),
    change = {
      enabled: true,
      values: { host: "a.invalid" },
      expectedRevision: 0,
    };
  await assert.rejects(
    saveProjectPlugin(
      f.home,
      a,
      "http://127.0.0.1:23456",
      "invented-source",
      change,
      async () => {
        throw new Error("fixture failure");
      },
    ),
    /fixture failure/,
  );
  assert.equal(projectPlugins(f.home, a)[0]!.configured, false);
  const old = path.join(f.dir, "existing");
  await saveProjectPlugin(
    f.home,
    a,
    "http://127.0.0.1:23456",
    "invented-source",
    change,
    configurePlugin,
    old,
  );
  await assert.rejects(
    saveProjectPlugin(
      f.home,
      b,
      "http://127.0.0.1:23456",
      "invented-source",
      change,
      configurePlugin,
      old,
    ),
    /already belongs/,
  );
  rmSync(path.join(f.pkg, "TOOLS.md"));
  assert.ok(launchContext(f.home, "http://127.0.0.1:23456", a).pluginError);
});
test("availability changes never run configure and a broken or unregistered plugin can be disabled", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const project = hive.getProjectBySlug("chapter");
  await saveProjectPlugin(
    f.home,
    project,
    "http://127.0.0.1:23456",
    "invented-source",
    { enabled: true, values: { host: "example.invalid" }, expectedRevision: 0 },
  );
  const profile = projectPlugins(f.home, project)[0]!.home;
  const config = readFileSync(path.join(profile, "config.json"), "utf8");
  rmSync(path.join(f.pkg, "tool"));
  assert.ok(
    launchContext(f.home, "http://127.0.0.1:23456", project).pluginError,
  );
  const app = createApp(hive);
  const patch = (enabled: boolean, expectedRevision: number) =>
    app.request("/api/ui/projects/chapter/plugins/invented-source", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled, expectedRevision }),
    });
  assert.equal((await patch(false, 1)).status, 200);
  assert.equal(
    launchContext(f.home, "http://127.0.0.1:23456", project).plugins.length,
    0,
  );
  assert.equal((await patch(true, 2)).status, 400);
  removePlugin(f.home, "invented-source");
  assert.equal(projectPlugins(f.home, project)[0]!.configured, true);
  assert.match(projectPlugins(f.home, project)[0]!.error!, /unavailable/);
  assert.equal((await patch(false, 2)).status, 200);
  assert.equal(readFileSync(path.join(profile, "config.json"), "utf8"), config);
});
test("profile aliases cannot bind one profile to different projects", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const a = hive.getProjectBySlug("chapter");
  const b = hive.createProject(hive.getAgent("human"), {
    name: "Other",
    slug: "other",
  });
  const parent = path.join(f.dir, "profiles");
  mkdirSync(parent);
  symlinkSync(parent, path.join(f.dir, "alias"));
  const change = {
    enabled: true,
    values: { host: "example.invalid" },
    expectedRevision: 0,
  };
  await saveProjectPlugin(
    f.home,
    a,
    "http://127.0.0.1:23456",
    "invented-source",
    change,
    configurePlugin,
    path.join(parent, "one"),
  );
  await assert.rejects(
    saveProjectPlugin(
      f.home,
      b,
      "http://127.0.0.1:23456",
      "invented-source",
      change,
      configurePlugin,
      path.join(f.dir, "alias", "one"),
    ),
    /already belongs/,
  );
});
test("concurrent stale saves configure a profile only once and registries are private", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const project = hive.getProjectBySlug("chapter");
  let calls = 0;
  const configure = async (...args: Parameters<typeof configurePlugin>) => {
    calls++;
    await configurePlugin(...args);
  };
  const change = {
    enabled: true,
    values: { host: "example.invalid" },
    expectedRevision: 0,
  };
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      saveProjectPlugin(
        f.home,
        project,
        "http://127.0.0.1:23456",
        "invented-source",
        change,
        configure,
      ),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(calls, 1);
  for (const file of ["plugins.json", "project-plugins.json"])
    assert.equal(statSync(path.join(f.home, file)).mode & 0o777, 0o600);
});
test("plugins without fields can still configure an isolated profile", async (t) => {
  const f = setup(t);
  const manifest = JSON.parse(readFileSync(f.manifest, "utf8"));
  delete manifest.settings;
  writeFileSync(f.manifest, JSON.stringify(manifest));
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const project = hive.getProjectBySlug("chapter");
  assert.equal(existsSync(path.join(f.home, "profiles")), false);
  const saved = await saveProjectPlugin(
    f.home,
    project,
    "http://127.0.0.1:23456",
    "invented-source",
    { enabled: true, values: {}, expectedRevision: 0 },
  );
  assert.deepEqual(saved.settings?.fields, []);
  assert.equal(
    launchContext(f.home, "http://127.0.0.1:23456", project).plugins.length,
    1,
  );
});
test("launch fails visibly for invalid retained settings or a profile pointing at another server", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const project = hive.getProjectBySlug("chapter");
  const saved = await saveProjectPlugin(
    f.home,
    project,
    "http://127.0.0.1:23456",
    "invented-source",
    { enabled: true, values: { host: "example.invalid" }, expectedRevision: 0 },
  );
  assert.match(
    launchContext(f.home, "http://127.0.0.1:34567", project).pluginError!,
    /different Hivemind server/,
  );
  writeFileSync(
    path.join(saved.home, "config.json"),
    JSON.stringify({ hiveUrl: "http://127.0.0.1:23456", host: false }),
  );
  assert.match(
    launchContext(f.home, "http://127.0.0.1:23456", project).pluginError!,
    /invalid value/,
  );
});
test("configuration byte limits include defaults and hiveUrl before invoking the plugin", async (t) => {
  const url = "http://127.0.0.1:23456";
  for (const symbol of ["x", "é", "🙂", '"']) {
    const f = setup(t);
    const schema = settingsSchema.parse({
      version: 1,
      fields: [
        { key: "filters", label: "Filters", type: "strings", required: true },
        {
          key: "includeResolved",
          label: "Include resolved",
          type: "boolean",
          default: false,
        },
      ],
    });
    writeFileSync(path.join(f.pkg, "settings.json"), JSON.stringify(schema));
    registerPlugin(f.home, f.manifest);
    const hive = new Hive(path.join(f.home, "hive.db"));
    t.after(() => hive.db.close());
    const project = hive.getProjectBySlug("chapter");
    const valuesOfSize = (bytes: number) => {
      const values = { filters: Array.from({ length: 20 }, () => "x") };
      const serialized = () =>
        JSON.stringify({ ...values, includeResolved: false, hiveUrl: url });
      let remaining = bytes - Buffer.byteLength(serialized(), "utf8");
      const symbolBytes = Buffer.byteLength(JSON.stringify(symbol), "utf8") - 2;
      for (let i = 0; i < values.filters.length; i++) {
        const count = Math.min(
          Math.floor(4095 / symbol.length),
          Math.floor(remaining / symbolBytes),
        );
        values.filters[i] += symbol.repeat(count);
        remaining -= count * symbolBytes;
      }
      values.filters[19] += "x".repeat(remaining);
      validateSettings(schema, values);
      assert.equal(Buffer.byteLength(serialized(), "utf8"), bytes);
      return values;
    };
    let calls = 0;
    const configure = async (...args: Parameters<typeof configurePlugin>) => {
      calls++;
      await configurePlugin(...args);
    };
    let revision = 0;
    for (const bytes of [MAX_PLUGIN_JSON_BYTES - 1, MAX_PLUGIN_JSON_BYTES]) {
      const saved = await saveProjectPlugin(
        f.home,
        project,
        url,
        "invented-source",
        {
          enabled: true,
          values: valuesOfSize(bytes),
          expectedRevision: revision,
        },
        configure,
      );
      revision = saved.revision;
      assert.equal(statSync(path.join(saved.home, "config.json")).size, bytes);
      assert.equal(saved.error, undefined);
      assert.equal(launchContext(f.home, url, project).pluginError, undefined);
    }
    const before = projectPlugins(f.home, project)[0]!;
    const configFile = path.join(before.home, "config.json");
    const registryFile = path.join(f.home, "project-plugins.json");
    const config = readFileSync(configFile, "utf8");
    const registry = readFileSync(registryFile, "utf8");
    const stateFile = path.join(before.home, "retained-state.json");
    writeFileSync(stateFile, '{"cursor":"invented-retained-state"}');
    const oversized = valuesOfSize(MAX_PLUGIN_JSON_BYTES + 1);
    // The user values alone fit; only the complete persisted configuration exceeds the limit.
    assert.ok(
      Buffer.byteLength(JSON.stringify(oversized), "utf8") <
        MAX_PLUGIN_JSON_BYTES,
    );
    if (symbol === "é" || symbol === "🙂")
      assert.ok(JSON.stringify(oversized).length < MAX_PLUGIN_JSON_BYTES);
    await assert.rejects(
      saveProjectPlugin(
        f.home,
        project,
        url,
        "invented-source",
        {
          enabled: false,
          values: oversized,
          expectedRevision: revision,
        },
        configure,
      ),
      /65536 UTF-8 bytes.*plugin was not run/,
    );
    assert.equal(calls, 2, "Rejected input must not invoke configure");
    assert.equal(readFileSync(configFile, "utf8"), config);
    assert.equal(readFileSync(registryFile, "utf8"), registry);
    assert.equal(
      readFileSync(stateFile, "utf8"),
      '{"cursor":"invented-retained-state"}',
    );
    assert.deepEqual(projectPlugins(f.home, project)[0], before);
    assert.equal(launchContext(f.home, url, project).pluginError, undefined);
    assert.equal(existsSync(path.join(f.home, "plugins.lock")), false);
    // A rejected save also releases the queue/lock and leaves the revision usable.
    const retried = await saveProjectPlugin(
      f.home,
      project,
      url,
      "invented-source",
      {
        enabled: true,
        values: { filters: ["valid retry"] },
        expectedRevision: revision,
      },
      configure,
    );
    assert.equal(retried.revision, revision + 1);
    assert.equal(calls, 3);
  }
});

test("oversized first configuration is rejected over HTTP without creating a profile", async (t) => {
  const f = setup(t);
  writeFileSync(
    path.join(f.pkg, "settings.json"),
    JSON.stringify({
      version: 1,
      fields: [
        { key: "filters", label: "Filters", type: "strings", required: true },
      ],
    }),
  );
  // If configure were reached, this marker would expose the side effect.
  const marker = path.join(f.dir, "configure-was-run");
  writeFileSync(
    path.join(f.pkg, "tool"),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'invoked');process.exit(1);\n`,
  );
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const app = createApp(hive);
  const response = await app.request(
    "http://127.0.0.1:23456/api/ui/projects/chapter/plugins/invented-source",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        values: { filters: Array(17).fill("x".repeat(4096)) },
        expectedRevision: 0,
      }),
    },
  );
  assert.equal(response.status, 400);
  assert.match(
    ((await response.json()) as { error: string }).error,
    /65536 UTF-8 bytes.*plugin was not run/,
  );
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(path.join(f.home, "profiles")), false);
  assert.equal(existsSync(path.join(f.home, "project-plugins.json")), false);
  assert.equal(existsSync(path.join(f.home, "plugins.lock")), false);
});

test("persisted output is still size-checked if the external plugin expands valid input", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  await assert.rejects(
    saveProjectPlugin(
      f.home,
      hive.getProjectBySlug("chapter"),
      "http://127.0.0.1:23456",
      "invented-source",
      {
        enabled: true,
        values: { host: "example.invalid" },
        expectedRevision: 0,
      },
      async (...args) => {
        await configurePlugin(...args);
        const file = path.join(args[1], "config.json");
        writeFileSync(
          file,
          readFileSync(file, "utf8") + " ".repeat(MAX_PLUGIN_JSON_BYTES),
        );
      },
    ),
    /Plugin file exceeds 64 KB/,
  );
  assert.equal(existsSync(path.join(f.home, "project-plugins.json")), false);
});

test("schema upgrades retain repairable form values and can be saved through the HTTP API", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const project = hive.getProjectBySlug("chapter");
  const url = "http://127.0.0.1:23456";
  const saved = await saveProjectPlugin(
    f.home,
    project,
    url,
    "invented-source",
    {
      enabled: true,
      values: { host: "example.invalid", interval: 600 },
      expectedRevision: 0,
    },
  );
  const configFile = path.join(saved.home, "config.json");
  const original = readFileSync(configFile, "utf8");
  const schema = JSON.parse(
    readFileSync(path.join(f.pkg, "settings.json"), "utf8"),
  );
  schema.fields.push({
    key: "region",
    label: "Region",
    type: "string",
    required: true,
  });
  writeFileSync(path.join(f.pkg, "settings.json"), JSON.stringify(schema));
  const app = createApp(hive);
  const endpoint = url + "/api/ui/projects/chapter/plugins";
  const response = await app.request(endpoint);
  const view = ((await response.json()) as any).plugins[0];
  assert.equal(response.status, 200);
  assert.equal(view.settings.fields.length, 3);
  assert.deepEqual(view.values, { host: "example.invalid", interval: 600 });
  assert.match(view.error, /Region is required/);
  assert.equal(view.revision, 1);
  assert.equal(
    readFileSync(configFile, "utf8"),
    original,
    "Viewing a draft must not write settings",
  );
  assert.match(
    launchContext(f.home, url, project).pluginError!,
    /Region is required/,
  );
  const put = (values: unknown) =>
    app.request(endpoint + "/invented-source", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        values,
        enabled: true,
        expectedRevision: view.revision,
      }),
    });
  assert.equal(
    (await put(view.values)).status,
    400,
    "The draft is not a validated config",
  );
  assert.equal(readFileSync(configFile, "utf8"), original);
  const repairedResponse = await put({ ...view.values, region: "test-region" });
  assert.equal(repairedResponse.status, 200);
  const repaired = ((await repairedResponse.json()) as any).plugin;
  assert.equal(repaired.error, undefined);
  assert.equal(repaired.revision, 2);
  assert.equal(repaired.home, saved.home);
  assert.equal(repaired.values.region, "test-region");
  assert.equal(launchContext(f.home, url, project).pluginError, undefined);
  assert.equal(launchContext(f.home, url, project).plugins.length, 1);
});

test("unreadable saved settings remain repairable without treating defaults as a valid profile", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const project = hive.getProjectBySlug("chapter");
  const url = "http://127.0.0.1:23456";
  const saved = await saveProjectPlugin(
    f.home,
    project,
    url,
    "invented-source",
    {
      enabled: false,
      values: { host: "example.invalid" },
      expectedRevision: 0,
    },
  );
  const configFile = path.join(saved.home, "config.json");
  for (const contents of ["{broken JSON", "null", "[]"]) {
    writeFileSync(configFile, contents);
    const draft = projectPlugins(f.home, project)[0]!;
    assert.ok(draft.settings);
    assert.deepEqual(draft.values, { interval: 300 });
    assert.match(draft.error!, /unreadable.*Configure/);
    assert.equal(readFileSync(configFile, "utf8"), contents);
    await assert.rejects(
      setProjectPluginAvailability(f.home, project, "invented-source", {
        enabled: true,
        expectedRevision: 1,
      }),
    );
  }
  const repaired = await saveProjectPlugin(
    f.home,
    project,
    url,
    "invented-source",
    {
      enabled: true,
      values: { host: "repaired.invalid" },
      expectedRevision: 1,
    },
  );
  assert.equal(repaired.error, undefined);
  assert.equal(repaired.revision, 2);
});

test("repair drafts keep compatible fields only, including false and zero, and omit removed keys", () => {
  const schema = settingsSchema.parse({
    version: 1,
    fields: [
      { key: "host", label: "Host", type: "string", required: true },
      { key: "count", label: "Count", type: "integer" },
      { key: "active", label: "Active", type: "boolean" },
      { key: "tags", label: "Tags", type: "strings" },
      { key: "region", label: "Region", type: "string", required: true },
    ],
  });
  const recovered = recoverSettings(schema, {
    host: "example.invalid",
    count: 0,
    active: false,
    tags: 42,
    removed: "unused",
  });
  assert.deepEqual(recovered, {
    host: "example.invalid",
    count: 0,
    active: false,
  });
  assert.throws(
    () => validateSettings(schema, recovered),
    /Region is required/,
  );
  assert.deepEqual(
    recoverSettings(schema, Object.create({ host: "inherited.invalid" })),
    {},
  );
});

test("worker launch keeps exact MCP binding when packages, profiles or registries fail", async (t) => {
  for (const failure of ["package", "profile", "catalog", "bindings"]) {
    const f = setup(t);
    registerPlugin(f.home, f.manifest);
    const hive = new Hive(path.join(f.home, "hive.db"));
    t.after(() => hive.db.close());
    const project = hive.getProjectBySlug("chapter");
    const url = "http://127.0.0.1:23456";
    const saved = await saveProjectPlugin(
      f.home,
      project,
      url,
      "invented-source",
      {
        enabled: true,
        values: { host: "example.invalid" },
        expectedRevision: 0,
      },
    );
    const binding = launchContext(f.home, url, project).hivemindMcp;
    if (failure === "package") rmSync(path.join(f.pkg, "tool"));
    if (failure === "profile")
      writeFileSync(path.join(saved.home, "config.json"), "{}");
    if (failure === "catalog")
      writeFileSync(path.join(f.home, "plugins.json"), "{broken");
    if (failure === "bindings")
      writeFileSync(path.join(f.home, "project-plugins.json"), "{broken");
    const response = await createApp(hive).request(
      url + "/api/ui/launch-context?project=chapter",
    );
    assert.equal(response.status, 200, failure);
    const context = (await response.json()) as ReturnType<typeof launchContext>;
    assert.ok(context.pluginError, failure);
    assert.deepEqual(context.hivemindMcp, binding, failure);
    assert.deepEqual(context.plugins, []);
    assert.equal(context.pluginInstructions, "");
    assert.throws(() => projectLaunchTools(context, project, "brain"));
    const tools = projectLaunchTools(context, project, "worker");
    assert.deepEqual(tools, { hivemindMcp: binding });
    for (const resume of [false, true]) {
      const command = buildLaunchBlock({
        ...base,
        ...tools,
        software: "claude",
        role: "worker",
        seniority: "senior",
        projectSlug: project.slug,
        resume,
        resumeName: "Fixture",
      });
      assert.match(command, /--mcp-config/);
      assert.ok(command.includes('"HIVEMIND_URL":"' + url + '"'));
      assert.doesNotMatch(command, /Installed plugin:/);
    }
  }
});

test("configure failures and invalid receipts never enable the plugin", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const project = hive.getProjectBySlug("chapter");
  for (const code of [
    'console.log(JSON.stringify({configured:false,error:"Invented rejection"}));process.exit(2);',
    'console.log("not a receipt");',
    'console.log("x".repeat(70000));',
    "console.log(JSON.stringify({configured:true}));",
  ]) {
    writeFileSync(
      path.join(f.pkg, "tool"),
      "#!" + process.execPath + "\n" + code,
      { mode: 0o700 },
    );
    await assert.rejects(
      saveProjectPlugin(
        f.home,
        project,
        "http://127.0.0.1:23456",
        "invented-source",
        {
          enabled: true,
          values: { host: "example.invalid" },
          expectedRevision: 0,
        },
      ),
    );
    assert.equal(projectPlugins(f.home, project)[0]!.configured, false);
  }
});
test("schemas reject contradictory types, invalid defaults and null or empty required values", () => {
  for (const field of [
    { key: "amount", label: "Amount", type: "integer", choices: ["one"] },
    { key: "enabled", label: "Enabled", type: "boolean", minimum: 0 },
    { key: "text", label: "Text", type: "string", minLength: 10, maxLength: 2 },
    { key: "amount", label: "Amount", type: "integer", minimum: 5, default: 1 },
    { key: "text", label: "Text", type: "string", default: ["invalid"] },
  ])
    assert.throws(() => settingsSchema.parse({ version: 1, fields: [field] }));
  const schema = settingsSchema.parse({
    version: 1,
    fields: [{ key: "list", label: "List", type: "strings", required: true }],
  });
  for (const list of [null, [], "a", [null]])
    assert.throws(() => validateSettings(schema, { list }));
  assert.deepEqual(validateSettings(schema, { list: ["a"] }), { list: ["a"] });
});
test("fresh and resumed launch uses only the selected project across all CLI families", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const project = hive.getProjectBySlug("chapter");
  const other = hive.createProject(hive.getAgent("human"), {
    name: "Other",
    slug: "other",
  });
  await saveProjectPlugin(
    f.home,
    project,
    "http://127.0.0.1:23456",
    "invented-source",
    { enabled: true, values: { host: "example.invalid" }, expectedRevision: 0 },
  );
  const context = launchContext(f.home, "http://127.0.0.1:23456", project);
  assert.throws(
    () => projectLaunchTools(context, other, "brain"),
    /unavailable/,
  );
  assert.throws(
    () => projectLaunchTools(undefined, project, "brain"),
    /unavailable/,
  );
  assert.throws(
    () => projectLaunchTools(undefined, project, "worker"),
    /unavailable/,
  );
  assert.throws(
    () => projectLaunchTools(context, other, "worker"),
    /unavailable/,
  );
  for (const software of [
    "claude",
    "codex",
    "agent",
    "opencode",
    "custom-client",
  ]) {
    for (const resume of [false, true]) {
      const input = {
        ...base,
        software,
        resume,
        resumeName: "Fixture",
        projectSlug: project.slug,
        ...projectLaunchTools(context, project, "brain"),
      };
      const prompt = buildLaunchPrompt(input);
      assert.ok(prompt.startsWith(ADOPT_UNTRUSTED));
      assert.match(prompt, /Installed plugin: Invented Source/);
      assert.match(prompt, /coordinate workers, do not implement/);
      assert.doesNotMatch(
        prompt,
        /effectiveDirective|TASK_EXECUTION|perform Human-assigned work directly/,
      );
      assert.throws(
        () => buildLaunchPrompt({ ...input, passProject: false }),
        /matching launch project/,
      );
      assert.doesNotMatch(
        buildLaunchPrompt({ ...input, role: "worker", seniority: "senior" }),
        /Invented Source/,
      );
    }
  }
});
test("CLI registers and lists only installed local code; binding uses an explicit project", (t) => {
  const f = setup(t);
  const invoke = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        path.resolve("src/cli.ts"),
        "plugins",
        ...args,
        "--home",
        f.home,
      ],
      { encoding: "utf8" },
    );
  assert.equal(invoke(["add", f.manifest]).status, 0);
  assert.equal(JSON.parse(invoke(["list"]).stdout)[0].id, "invented-source");
  assert.equal(existsSync(path.join(f.home, "profiles")), false);
  assert.notEqual(
    invoke([
      "add",
      f.manifest,
      "--config-home",
      path.join(f.dir, "global-profile"),
    ]).status,
    0,
  );
  assert.equal(invoke(["remove", "invented-source"]).status, 0);
});

test("localhost uses the same numeric-loopback profile and non-local origins never configure", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const project = hive.getProjectBySlug("chapter");
  const change = {
    enabled: true,
    values: { host: "example.invalid" },
    expectedRevision: 0,
  };
  for (const url of [
    "https://example.invalid",
    "http://example.invalid",
    "http://user:pass@127.0.0.1:12345",
  ]) {
    await assert.rejects(
      saveProjectPlugin(f.home, project, url, "invented-source", change),
      /local Hivemind/,
    );
  }
  const saved = await saveProjectPlugin(
    f.home,
    project,
    "http://localhost:12345",
    "invented-source",
    change,
  );
  assert.equal(
    JSON.parse(readFileSync(path.join(saved.home, "config.json"), "utf8"))
      .hiveUrl,
    "http://127.0.0.1:12345",
  );
  assert.deepEqual(
    launchContext(f.home, "http://localhost:12345", project),
    launchContext(f.home, "http://127.0.0.1:12345", project),
  );
});

test("a server update and another CLI process cannot mutate the catalog or profiles concurrently", async (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  t.after(() => hive.db.close());
  const project = hive.getProjectBySlug("chapter");
  const configure = async (...args: Parameters<typeof configurePlugin>) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        path.resolve("src/cli.ts"),
        "plugins",
        "remove",
        "invented-source",
        "--home",
        f.home,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /plugins.lock/);
    await configurePlugin(...args);
  };
  await saveProjectPlugin(
    f.home,
    project,
    "http://127.0.0.1:12345",
    "invented-source",
    { enabled: true, values: { host: "example.invalid" }, expectedRevision: 0 },
    configure,
  );
  assert.equal(listPlugins(f.home).length, 1);
  assert.equal(existsSync(path.join(f.home, "plugins.lock")), false);
  writeFileSync(path.join(f.home, "plugins.lock"), "retained test lock");
  assert.throws(() => removePlugin(f.home, "invented-source"), /plugins.lock/);
  unlinkSync(path.join(f.home, "plugins.lock"));
  removePlugin(f.home, "invented-source");
});

test("CLI binds an existing profile without copying or erasing retained state", (t) => {
  const f = setup(t);
  registerPlugin(f.home, f.manifest);
  const hive = new Hive(path.join(f.home, "hive.db"));
  const project = hive.getProjectBySlug("chapter");
  hive.db.close();
  const profile = path.join(f.dir, "retained profile");
  mkdirSync(profile);
  writeFileSync(
    path.join(profile, "config.json"),
    JSON.stringify({
      hiveUrl: "http://127.0.0.1:12345",
      host: "example.invalid",
    }),
  );
  writeFileSync(path.join(profile, "cursor.json"), '{"cursor":42}');
  const invoke = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        path.resolve("src/cli.ts"),
        "plugins",
        ...args,
        "--home",
        f.home,
      ],
      { encoding: "utf8" },
    );
  const result = invoke([
    "bind",
    "invented-source",
    "--project",
    "chapter",
    "--config-home",
    profile,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).monitorStarted, false);
  assert.equal(
    readFileSync(path.join(profile, "cursor.json"), "utf8"),
    '{"cursor":42}',
  );
  assert.equal(projectPlugins(f.home, project)[0]!.home, realpathSync(profile));
  assert.notEqual(
    invoke(["remove", "invented-source", "--project", "chapter"]).status,
    0,
  );
  assert.equal(listPlugins(f.home).length, 1);
});
