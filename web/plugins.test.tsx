import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PluginEditor,
  PluginFields,
  ProjectPlugins,
  pluginFormValues,
} from "./ProjectPlugins.tsx";
import {
  settingsSchema,
  validateSettings,
  type ProjectPluginView,
} from "../src/shared/plugin-settings.ts";

const project = {
  id: "fixture-project",
  slug: "example",
  name: "Example",
  worktree: null,
  createdAt: 0,
};
const plugin: ProjectPluginView = {
  id: "example-source",
  name: "Example Source",
  home: "/tmp/example-profile",
  enabled: false,
  configured: false,
  revision: 0,
  values: {},
  settings: { version: 1, fields: [] },
};

test("untouched required and optional checkboxes submit explicit false without mutating saved values", () => {
  const settings = settingsSchema.parse({
    version: 1,
    fields: [
      {
        key: "includeResolved",
        label: "Include resolved",
        type: "boolean",
        required: true,
      },
      { key: "optionalFlag", label: "Optional flag", type: "boolean" },
    ],
  });
  const saved = {};
  const values = pluginFormValues({ settings, values: saved });
  assert.deepEqual(values, { includeResolved: false, optionalFlag: false });
  assert.deepEqual(validateSettings(settings, values), values);
  assert.deepEqual(saved, {});
  const html = renderToStaticMarkup(
    <PluginFields
      settings={settings}
      values={values}
      disabled={false}
      onChange={() => {}}
    />,
  );
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /checked=""/);
});

test("checkbox initialization preserves schema defaults and explicit false overrides", () => {
  const settings = settingsSchema.parse({
    version: 1,
    fields: [
      {
        key: "defaultOn",
        label: "Default on",
        type: "boolean",
        default: true,
        required: true,
      },
      {
        key: "defaultOff",
        label: "Default off",
        type: "boolean",
        default: false,
      },
      {
        key: "overridden",
        label: "Overridden",
        type: "boolean",
        default: true,
      },
      { key: "selected", label: "Selected", type: "boolean" },
    ],
  });
  const saved = { overridden: false, selected: true };
  const values = pluginFormValues({ settings, values: saved });
  assert.deepEqual(values, {
    overridden: false,
    selected: true,
    defaultOn: true,
    defaultOff: false,
  });
  assert.deepEqual(validateSettings(settings, values), values);
  assert.deepEqual(saved, { overridden: false, selected: true });
});

test("checkbox initialization does not bypass required fields or coerce invalid saved values", () => {
  const settings = settingsSchema.parse({
    version: 1,
    fields: [
      { key: "host", label: "Host", type: "string", required: true },
      { key: "flag", label: "Flag", type: "boolean", required: true },
    ],
  });
  const values = pluginFormValues({ settings, values: {} });
  assert.deepEqual(values, { flag: false });
  assert.throws(() => validateSettings(settings, values), /Host is required/);
  assert.throws(
    () =>
      validateSettings(
        settings,
        pluginFormValues({
          settings,
          values: { host: "example.invalid", flag: "invalid" },
        }),
      ),
    /expected boolean/,
  );
});

test("project plugin settings explain local configuration and independent monitor lifecycle", () => {
  const html = renderToStaticMarkup(
    <ProjectPlugins project={project} onClose={() => {}} />,
  );
  assert.match(html, /aria-label="Plugins for Example"/);
  assert.match(html, /Opening this panel reads local files only/);
  assert.match(html, /does not start or stop existing monitors/);
  assert.match(html, /Loading…/);
});

test("field-free plugins remain configurable, without injecting package markup", () => {
  const html = renderToStaticMarkup(
    <PluginEditor
      plugin={{ ...plugin, name: "<script>Example</script>" }}
      project={project}
      busy={false}
      onBusy={() => {}}
      onSaved={() => {}}
    />,
  );
  assert.match(html, /&lt;script&gt;Example&lt;\/script&gt;/);
  assert.match(html, /Not configured/);
  assert.match(html, /<button type="button">Configure<\/button>/);
  assert.doesNotMatch(html, /<script>/);
});

test("a broken enabled plugin can be disabled without configuring it", () => {
  const html = renderToStaticMarkup(
    <PluginEditor
      plugin={{
        ...plugin,
        enabled: true,
        configured: true,
        settings: undefined,
        error: "Package unavailable",
      }}
      project={project}
      busy={false}
      onBusy={() => {}}
      onSaved={() => {}}
    />,
  );
  assert.match(html, /<button type="button">Disable for project<\/button>/);
  assert.match(html, /<button type="button" disabled="">Configure<\/button>/);
});

test("invalid saved values keep Configure available but cannot be enabled before repair", () => {
  for (const enabled of [false, true]) {
    const html = renderToStaticMarkup(
      <PluginEditor
        plugin={{
          ...plugin,
          enabled,
          configured: true,
          error: "Region is required. Open Configure to correct it.",
        }}
        project={project}
        busy={false}
        onBusy={() => {}}
        onSaved={() => {}}
      />,
    );
    assert.match(html, /<button type="button">Configure<\/button>/);
    assert.match(html, /role="alert"/);
    if (enabled)
      assert.match(html, /<button type="button">Disable for project<\/button>/);
    else
      assert.match(
        html,
        /<button type="button" disabled="">Enable for project<\/button>/,
      );
  }
});

test("generic form renders all field types and required choices have an explicit empty selection", () => {
  const settings = settingsSchema.parse({
    version: 1,
    fields: [
      { key: "host", label: "Host", type: "string", required: true },
      {
        key: "mode",
        label: "Mode",
        type: "string",
        choices: ["one", "two"],
        required: true,
      },
      {
        key: "count",
        label: "Count",
        type: "integer",
        minimum: 1,
        maximum: 20,
      },
      { key: "enabled", label: "Enabled", type: "boolean" },
      { key: "names", label: "Names", type: "strings" },
    ],
  });
  const html = renderToStaticMarkup(
    <PluginFields
      settings={settings}
      values={{ enabled: true, count: 2, names: ["a", "b"] }}
      disabled={false}
      onChange={() => {}}
    />,
  );
  assert.match(html, /type="number" min="1" max="20" step="1"/);
  assert.match(html, /<option value="" selected="">Choose…<\/option>/);
  assert.match(html, /type="checkbox" checked=""/);
  assert.match(html, /<textarea[^>]*>a\nb<\/textarea>/);
});

test("a pending save disables actions on other plugin cards", () => {
  const html = renderToStaticMarkup(
    <PluginEditor
      plugin={{ ...plugin, configured: true }}
      project={project}
      busy={true}
      onBusy={() => {}}
      onSaved={() => {}}
    />,
  );
  assert.match(
    html,
    /<button type="button" disabled="">Enable for project<\/button>/,
  );
  assert.match(html, /<button type="button" disabled="">Configure<\/button>/);
});
