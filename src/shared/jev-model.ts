/** Provider alias used when no model is pinned. An alias may resolve to different models over time. */
export const JEV_MODEL_ALIAS = "jev-latest";

/**
 * A bounded Jev model identifier: letters, digits, dot, underscore and hyphen only (at most 64). No slash or
 * colon, so it can never be a URL, host or path, and the fixed TypeSafe endpoint is never derived from it.
 */
export const JEV_MODEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export function validJevModel(value: unknown): value is string {
  return typeof value === "string" && JEV_MODEL_PATTERN.test(value);
}
