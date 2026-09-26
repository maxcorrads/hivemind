import { useState } from "react";
import { api } from "./api.ts";
import type { Project } from "../src/shared/types.ts";
import {
  validateSettings,
  type BotSettingsSchema,
  type ProjectBotConfiguration,
  type SettingsValues,
} from "../src/shared/bot-settings.ts";

/** Bot settings retain explicit values/defaults; an unset checkbox starts at false. */
export function botFormValues(
  configuration: Pick<ProjectBotConfiguration, "settings" | "values">,
): SettingsValues {
  const values = { ...configuration.values };
  for (const field of configuration.settings?.fields ?? []) {
    if (field.type === "boolean" && !Object.hasOwn(values, field.key)) {
      values[field.key] = field.default ?? false;
    }
  }
  return values;
}

/** Validate the draft without normalizing schema-valid list entries. */
export function botSavePayload(
  settings: BotSettingsSchema,
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

export function BotSettingsFields({
  settings,
  values,
  disabled,
  onChange,
}: {
  settings: BotSettingsSchema;
  values: SettingsValues;
  disabled: boolean;
  onChange: (key: string, value: SettingsValues[string] | undefined) => void;
}) {
  return (
    <div className="bot-settings-fields">
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

export function BotSettingsEditor({
  configuration,
  project,
  busy,
  onBusy,
  onSaved,
}: {
  configuration: ProjectBotConfiguration;
  project: Project;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onSaved: (configuration: ProjectBotConfiguration) => void;
}) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(configuration.enabled);
  const [values, setValues] = useState(() => botFormValues(configuration));
  const [error, setError] = useState("");
  const run = async (action: () => Promise<{ configuration: ProjectBotConfiguration }>) => {
    setError("");
    onBusy(true);
    try {
      onSaved((await action()).configuration);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      onBusy(false);
    }
  };
  return (
    <section className="bot-settings-card">
      <div className="bot-settings-heading">
        <strong>{configuration.name}</strong>
        <span>
          {configuration.enabled
            ? "Service enabled"
            : configuration.configured
              ? "Configured · service disabled"
              : "Not configured"}
        </span>
        {configuration.configured && (
          <button
            type="button"
            disabled={busy || (!!configuration.error && !configuration.enabled)}
            onClick={() =>
              void run(() =>
                api.setBotAvailability(project.slug, configuration.id, {
                  enabled: !configuration.enabled,
                  expectedRevision: configuration.revision,
                }),
              )
            }
          >
            {configuration.enabled ? "Disable for project" : "Enable for project"}
          </button>
        )}
        <button
          type="button"
          disabled={busy || !configuration.settings}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide settings" : "Configure"}
        </button>
      </div>
      {configuration.error && <p role="alert">{configuration.error}</p>}
      {error && (
        <p role="alert">
          {error} Reload saved settings before retrying a stale change.
        </p>
      )}
      {open && configuration.settings && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              return api.saveProjectBotConfiguration(
                project.slug,
                configuration.id,
                botSavePayload(
                  configuration.settings!,
                  values,
                  enabled,
                  configuration.revision,
                ),
              );
            });
          }}
        >
          {configuration.settings.description && <p>{configuration.settings.description}</p>}
          <label className="check">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => setEnabled(event.target.checked)}
            />{" "}
            Enable service for this project after saving
          </label>
          <BotSettingsFields
            settings={configuration.settings}
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
            Local profile: <code>{configuration.home}</code>
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
