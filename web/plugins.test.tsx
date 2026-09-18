import assert from "node:assert/strict";
import { test } from "node:test";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PluginEditor,
  PluginFields,
  ProjectPlugins,
  pluginFormValues,
  pluginSavePayload,
} from "./ProjectPlugins.tsx";
import {
  settingsSchema,
  validateSettings,
  type ProjectPluginView,
  type SettingsValues,
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

for (const [name, choices] of [
  ["free-form strings", undefined],
  ["whitespace-sensitive choices", ["  significant whitespace  ", "", "ordinary", "\t"]],
] as const) {
  test(`load and save without edits preserves ${name}, empty entries and empty arrays`, () => {
    const settings = settingsSchema.parse({
      version: 1,
      fields: [
        { key: "values", label: "Values", type: "strings", choices },
        { key: "emptyList", label: "Empty list", type: "strings", minLength: 1 },
        { key: "emptyEntry", label: "Empty entry", type: "strings" },
        { key: "unset", label: "Unset", type: "strings" },
      ],
    });
    const saved = {
      values: ["  significant whitespace  ", "", "ordinary", "\t", "ordinary"],
      emptyList: [],
      emptyEntry: [""],
    };
    const original = structuredClone(saved);
    const values = pluginFormValues({ settings, values: saved });
    const payload = pluginSavePayload(settings, values, false, 7);
    assert.deepEqual(payload, { enabled: false, values: original, expectedRevision: 7 });
    assert.deepEqual(saved, original, "Saved settings must not be mutated");
    assert.deepEqual(values, original, "The form draft must not be mutated");
    assert.deepEqual(
      pluginSavePayload(settings, pluginFormValues({ settings, values: payload.values }), true, 8),
      { enabled: true, values: original, expectedRevision: 8 },
    );
  });
}

test("saving retains schema list defaults and validates blank entries rather than dropping them", () => {
  const settings = settingsSchema.parse({
    version: 1,
    fields: [
      { key: "defaults", label: "Defaults", type: "strings", default: [" spaced ", ""] },
      { key: "bounded", label: "Bounded", type: "strings", minLength: 1 },
      { key: "required", label: "Required", type: "strings", required: true },
    ],
  });
  assert.deepEqual(pluginSavePayload(settings, { required: ["ok"], bounded: [] }, true, 0).values,
    { defaults: [" spaced ", ""], bounded: [], required: ["ok"] });
  const invalidValues: SettingsValues[] = [
    { required: ["ok", ""] },
    { required: [] },
    { required: ["ok"], bounded: ["valid", ""] },
  ];
  for (const values of invalidValues) {
    assert.throws(() => pluginSavePayload(settings, values, true, 0), /invalid value/);
  }
});

function textareaProps(node: ReactNode): {
  value: string;
  onChange: (event: { target: { value: string } }) => void;
} | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; value: string; onChange: (event: { target: { value: string } }) => void }>(child)) continue;
    if (child.type === "textarea") return child.props;
    const found = textareaProps(child.props.children);
    if (found) return found;
  }
}

test("editing list fields preserves spaces and blank lines; clearing the editor saves an empty list", () => {
  const settings = settingsSchema.parse({
    version: 1,
    fields: [{ key: "values", label: "Values", type: "strings" }],
  });
  let values: SettingsValues = { values: ["initial"] };
  const control = textareaProps(PluginFields({ settings, values, disabled: false,
    onChange: (key, value) => { assert.notEqual(value, undefined); values = { [key]: value! }; },
  }));
  assert.ok(control);
  assert.equal(control.value, "initial");
  control.onChange({ target: { value: "  first  \n\n\t\nlast\n" } });
  assert.deepEqual(pluginSavePayload(settings, values, true, 2).values,
    { values: ["  first  ", "", "\t", "last", ""] });
  control.onChange({ target: { value: "" } });
  assert.deepEqual(values, { values: [] });
  assert.deepEqual(pluginSavePayload(settings, values, true, 2).values, { values: [] });
});

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
  assert.doesNotMatch(html, /<script\b/i);
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
