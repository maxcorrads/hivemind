import { z } from "zod";

const fieldSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/)
      .refine(
        (key) =>
          ![
            "hiveUrl",
            "projectId",
            "constructor",
            "prototype",
            "__proto__",
          ].includes(key),
      ),
    label: z.string().min(1).max(100),
    type: z.enum(["string", "integer", "boolean", "strings"]),
    description: z.string().max(600).optional(),
    required: z.boolean().default(false),
    default: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
      .optional(),
    choices: z.array(z.string().max(4096)).min(1).max(100).optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    minLength: z.number().int().nonnegative().max(4096).optional(),
    maxLength: z.number().int().positive().max(4096).optional(),
  })
  .strict();

type SettingField = z.infer<typeof fieldSchema>;
export type SettingsValues = Record<
  string,
  string | number | boolean | string[]
>;

function checkValue(
  field: SettingField,
  value: unknown,
): SettingsValues[string] {
  if (field.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      (field.minimum !== undefined && value < field.minimum) ||
      (field.maximum !== undefined && value > field.maximum)
    ) {
      throw new Error(field.label + ": invalid integer/range");
    }
  } else if (field.type === "boolean") {
    if (typeof value !== "boolean")
      throw new Error(field.label + ": expected boolean");
  } else {
    const strings = field.type === "strings" ? value : [value];
    if (
      !Array.isArray(strings) ||
      strings.length > 100 ||
      (field.required && strings.length === 0) ||
      strings.some(
        (item) =>
          typeof item !== "string" ||
          item.length < (field.minLength ?? (field.required ? 1 : 0)) ||
          item.length > (field.maxLength ?? 4096) ||
          (field.choices && !field.choices.includes(item)),
      )
    ) {
      throw new Error(field.label + ": invalid value");
    }
  }
  return value as SettingsValues[string];
}

export const settingsSchema = z
  .object({
    version: z.literal(1),
    description: z.string().max(1000).optional(),
    fields: z.array(fieldSchema).max(40),
  })
  .strict()
  .superRefine((schema, context) => {
    const invalid = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (
      new Set(schema.fields.map((field) => field.key)).size !==
      schema.fields.length
    )
      invalid("Duplicate setting key");
    for (const field of schema.fields) {
      if (
        (field.minimum !== undefined || field.maximum !== undefined) &&
        field.type !== "integer"
      ) {
        invalid(field.key + ": numeric bounds require an integer field");
      }
      if (
        (field.choices ||
          field.minLength !== undefined ||
          field.maxLength !== undefined) &&
        field.type !== "string" &&
        field.type !== "strings"
      ) {
        invalid(
          field.key + ": choices and length bounds require a string field",
        );
      }
      if (
        field.minimum !== undefined &&
        field.maximum !== undefined &&
        field.minimum > field.maximum
      )
        invalid("Invalid numeric bounds");
      if (
        field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.minLength > field.maxLength
      )
        invalid("Invalid length bounds");
      if (field.default !== undefined) {
        try {
          checkValue(field, field.default);
        } catch {
          invalid(field.key + ": invalid default");
        }
      }
    }
  });

export type BotSettingsSchema = z.infer<typeof settingsSchema>;
export const emptySettings: BotSettingsSchema = { version: 1, fields: [] };

export function validateSettings(
  schema: BotSettingsSchema,
  input: unknown,
): SettingsValues {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected settings object");
  const raw = input as Record<string, unknown>;
  const result: SettingsValues = {};
  const keys = new Set(schema.fields.map((field) => field.key));
  for (const key of Object.keys(raw))
    if (!keys.has(key)) throw new Error("Unknown setting");
  for (const field of schema.fields) {
    const value = Object.hasOwn(raw, field.key)
      ? raw[field.key]
      : field.default;
    if (value === undefined || (value === "" && !field.required)) {
      if (field.required) throw new Error(field.label + " is required");
      continue;
    }
    result[field.key] = checkValue(field, value);
  }
  return result;
}

/** Recover a form draft, not a valid configuration. Saving still validates every field. */
export function recoverSettings(
  schema: BotSettingsSchema,
  input: unknown,
): SettingsValues {
  const raw =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const result: SettingsValues = {};
  for (const field of schema.fields) {
    try {
      Object.assign(
        result,
        validateSettings(
          { version: 1, fields: [field] },
          Object.hasOwn(raw, field.key) ? { [field.key]: raw[field.key] } : {},
        ),
      );
    } catch {
      // Keep other valid fields, but never pass incompatible or unknown saved values to the form.
    }
  }
  return result;
}

/** An installed bot's configuration in one project; not a second service identity. */
export type ProjectBotConfiguration = {
  capabilities?: import('./bot-capabilities.ts').BotCapability[];
  tools?: import('./bot-tools.ts').BotTool[];
  id: string;
  name: string;
  settings?: BotSettingsSchema;
  values: SettingsValues;
  enabled: boolean;
  configured: boolean;
  home: string;
  revision: number;
  error?: string;
};
