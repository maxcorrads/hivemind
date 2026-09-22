import { Modal } from "./Modal.tsx";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Project } from "../src/shared/types.ts";
import {
  validateSettings,
  type PluginSettings,
  type ProjectPluginView,
  type SettingsValues,
} from "../src/shared/plugin-settings.ts";

/** Checkboxes have two states: retain explicit values/defaults, otherwise start at false. */
export function pluginFormValues(
  plugin: Pick<ProjectPluginView, "settings" | "values">,
): SettingsValues {
  const values = { ...plugin.values };
  for (const field of plugin.settings?.fields ?? []) {
    if (field.type === "boolean" && !Object.hasOwn(values, field.key)) {
      values[field.key] = field.default ?? false;
    }
  }
  return values;
}

/** Validate the draft without normalizing schema-valid list entries. */
export function pluginSavePayload(
  settings: PluginSettings,
  values: SettingsValues,
  enabled: boolean,
  expectedRevision: number,
) {
  return {
    enabled,
    values: validateSettings(settings, values),
    expectedRevision,
  };
}

export function PluginFields({
  settings,
  values,
  disabled,
  onChange,
}: {
  settings: PluginSettings;
  values: SettingsValues;
  disabled: boolean;
  onChange: (key: string, value: SettingsValues[string] | undefined) => void;
}) {
  return (
    <div className="plugin-fields">
      {settings.fields.map((field) => {
        const value = values[field.key];
        return (
          <label
            key={field.key}
            className={field.type === "boolean" ? "check" : ""}
          >
            {field.type === "boolean" ? (
              <>
                <input
                  type="checkbox"
                  checked={value === true}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(field.key, event.target.checked)
                  }
                />
                {field.label}
              </>
            ) : (
              <>
                {field.label}
                {field.required ? " *" : ""}
                {field.type === "strings" ? (
                  <textarea
                    rows={3}
                    aria-label={field.label}
                    value={Array.isArray(value) ? value.join("\n") : ""}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange(
                        field.key,
                        event.target.value === ""
                          ? []
                          : event.target.value.split("\n"),
                      )
                    }
                  />
                ) : field.choices ? (
                  <select
                    aria-label={field.label}
                    value={String(value ?? "")}
                    disabled={disabled}
                    required={field.required}
                    onChange={(event) =>
                      onChange(field.key, event.target.value)
                    }
                  >
                    <option value="">
                      {field.required ? "Choose…" : "Not set"}
                    </option>
                    {field.choices.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label={field.label}
                    type={field.type === "integer" ? "number" : "text"}
                    min={field.minimum}
                    max={field.maximum}
                    step={field.type === "integer" ? 1 : undefined}
                    minLength={field.minLength}
                    maxLength={field.maxLength ?? 4096}
                    required={field.required}
                    disabled={disabled}
                    value={String(value ?? "")}
                    onChange={(event) =>
                      onChange(
                        field.key,
                        field.type === "integer"
                          ? event.target.value === ""
                            ? undefined
                            : Number(event.target.value)
                          : event.target.value,
                      )
                    }
                  />
                )}
              </>
            )}
            {field.description && <small>{field.description}</small>}
            {field.type === "strings" && (
              <small>
                One value per line; spaces and blank lines are preserved. Clear
                the editor to empty the list.
                {field.choices
                  ? " Allowed values: " + field.choices.join(", ") + "."
                  : ""}
              </small>
            )}
          </label>
        );
      })}
    </div>
  );
}

export function PluginEditor({
  plugin,
  project,
  busy,
  onBusy,
  onSaved,
}: {
  plugin: ProjectPluginView;
  project: Project;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onSaved: (plugin: ProjectPluginView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(plugin.enabled);
  const [values, setValues] = useState(() => pluginFormValues(plugin));
  const [error, setError] = useState("");
  const run = async (action: () => Promise<{ plugin: ProjectPluginView }>) => {
    setError("");
    onBusy(true);
    try {
      onSaved((await action()).plugin);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      onBusy(false);
    }
  };
  return (
    <section className="plugin-card">
      <div className="plugin-heading">
        <strong>{plugin.name}</strong>
        <span>
          {plugin.enabled
            ? "Available to brain"
            : plugin.configured
              ? "Configured · not available to brain"
              : "Not configured"}
        </span>
        {plugin.configured && (
          <button
            type="button"
            disabled={busy || (!!plugin.error && !plugin.enabled)}
            onClick={() =>
              void run(() =>
                api.setPluginAvailability(project.slug, plugin.id, {
                  enabled: !plugin.enabled,
                  expectedRevision: plugin.revision,
                }),
              )
            }
          >
            {plugin.enabled ? "Disable for project" : "Enable for project"}
          </button>
        )}
        <button
          type="button"
          disabled={busy || !plugin.settings}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide settings" : "Configure"}
        </button>
      </div>
      {plugin.error && <p role="alert">{plugin.error}</p>}
      {error && (
        <p role="alert">
          {error} Reload saved settings before retrying a stale change.
        </p>
      )}
      {open && plugin.settings && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              return api.saveProjectPlugin(
                project.slug,
                plugin.id,
                pluginSavePayload(
                  plugin.settings!,
                  values,
                  enabled,
                  plugin.revision,
                ),
              );
            });
          }}
        >
          {plugin.settings.description && <p>{plugin.settings.description}</p>}
          <label className="check">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => setEnabled(event.target.checked)}
            />{" "}
            Available to this project’s brain after saving
          </label>
          <PluginFields
            settings={plugin.settings}
            values={values}
            disabled={busy}
            onChange={(key, value) => {
              setValues((old) => {
                const next = { ...old };
                if (value === undefined) delete next[key];
                else next[key] = value;
                return next;
              });
            }}
          />
          <p className="help-p">
            Local profile: <code>{plugin.home}</code>
          </p>
          <p className="help-p">
            Stop the profile’s monitor before changing its settings. Credentials
            stay with the provider CLI; do not paste passwords or tokens here.
          </p>
          <button type="submit" disabled={busy} className="primary">
            {busy ? "Saving…" : "Save locally"}
          </button>
        </form>
      )}
    </section>
  );
}

export function ProjectPlugins({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const [plugins, setPlugins] = useState<ProjectPluginView[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setPlugins(null);
    setError("");
    api
      .projectPlugins(project.slug)
      .then((result) => {
        if (active) setPlugins(result.plugins);
      })
      .catch((error) => {
        if (active) setError(String(error.message || error));
      });
    return () => {
      active = false;
    };
  }, [project.slug, reload]);
  return (
    <Modal onClose={() => { if (!busy) onClose(); }}>
      <div
        className="sheet sheet-wide"
        role="dialog"
        aria-modal="true"
        aria-label={"Plugins for " + project.name}
      >
        <h2>{project.name} · Plugins</h2>
        <div className="sheet-body">
          <p>
            Installed code is shared. Configuration, source state and
            availability are specific to this project.
          </p>
          <p className="help-p">
            Opening this panel reads local files only. Save invokes the trusted
            plugin’s configuration command, which must not start monitors or
            read providers.
          </p>
          <p className="help-p">
            Enabling or disabling changes launch instructions only. It does not
            start or stop existing monitors, or change running agents.
          </p>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {plugins === null && !error && <p>Loading…</p>}
          {plugins?.length === 0 && (
            <p>
              No installed plugins. Register a trusted package with{" "}
              <code>
                hivemind plugins add /path/hivemind-plugin.json --home
                /path/to/this/hive
              </code>
              .
            </p>
          )}
          {plugins?.map((plugin) => (
            <PluginEditor
              key={plugin.id + ":" + plugin.revision}
              plugin={plugin}
              project={project}
              busy={busy}
              onBusy={setBusy}
              onSaved={(saved) => {
                setPlugins((old) =>
                  old!.map((entry) => (entry.id === saved.id ? saved : entry)),
                );
                setNotice(
                  "Saved locally. Reopen the launch sheet to use the updated instructions.",
                );
              }}
            />
          ))}
        </div>
        <div className="row">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setReload((value) => value + 1);
              setNotice("");
            }}
          >
            Reload saved
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
