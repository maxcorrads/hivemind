// The Launch agent sheet's "Environment variables" field: one NAME=value per
// line, handed to the agent it launches. In the apps they travel as the
// launch's `environment` and reach the session's shell through the broker's
// private launch file, never argv (docs/terminal-broker.md#launch-environment);
// in a browser they prefix the copied command, single-quoted. HivemindKit's
// LaunchEnvironment checks exactly the same rules again: keep the two in step.

export const LAUNCH_ENVIRONMENT_LIMITS = {
  /** Variables in one launch. */
  variables: 32,
  /** UTF-8 bytes of one name, at most. */
  nameChars: 64,
  /** UTF-8 bytes of one value. */
  valueBytes: 8 * 1024,
  /** UTF-8 bytes of every `NAME=value` together. */
  totalBytes: 32 * 1024,
} as const;

/** A shell variable name: a letter or `_`, then letters, digits and `_`; 64 at most. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** What a value may not hold: control characters (C0 but tab, DEL, C1), so no NUL, CR or LF, and no lone surrogate. */
const BAD_VALUE = /(?!\t)\p{Cc}|\p{Cs}/u;

/**
 * Names the shell, the terminal, the loader or Hivemind own. Compared without case: zsh ties lowercase `path`,
 * `cdpath` and `fpath` to their uppercase variables, and one spelling is as dangerous as the other.
 */
export const LAUNCH_ENVIRONMENT_DENIED = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "PWD", "OLDPWD", "IFS", "ENV", "BASH_ENV", "ZDOTDIR",
  "CDPATH", "FPATH", "PS1", "PS2", "PS3", "PS4", "PROMPT_COMMAND", "TERM", "TMUX", "TMUX_PANE", "OPENCODE_API_KEY",
] as const;
/** Prefixes refused the same way (without case). */
export const LAUNCH_ENVIRONMENT_DENIED_PREFIXES = ["LD_", "DYLD_", "HIVEMIND_"] as const;

const utf8Length = (text: string) => new TextEncoder().encode(text).length;
/** launch-prompt's shSingleQuote, here too so neither module imports the other. */
const shSingleQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Why `name` cannot be set, or null. Names the variable, never a value. */
export function launchEnvironmentNameProblem(name: string): string | null {
  if (!NAME.test(name)) {
    return "a name is letters, digits and _, starts with a letter or _, and has at most 64 characters";
  }
  const upper = name.toUpperCase();
  if (upper === "OPENCODE_API_KEY") return "OPENCODE_API_KEY goes in the OpenCode Go API key field, which is never saved";
  if (upper.startsWith("HIVEMIND_")) return `${name}: Hivemind sets HIVEMIND_* variables itself`;
  if (upper.startsWith("LD_") || upper.startsWith("DYLD_")) return `${name}: LD_* and DYLD_* change how programs load and cannot be set`;
  if ((LAUNCH_ENVIRONMENT_DENIED as readonly string[]).includes(upper)) {
    return `${name} belongs to the shell or the terminal and cannot be set here`;
  }
  return null;
}

/** Why `value` cannot be passed, or null. Never quotes the value. */
export function launchEnvironmentValueProblem(value: string): string | null {
  if (BAD_VALUE.test(value)) return "a value cannot hold line breaks, NUL or other control characters";
  if (utf8Length(value) > LAUNCH_ENVIRONMENT_LIMITS.valueBytes) return `a value is at most ${LAUNCH_ENVIRONMENT_LIMITS.valueBytes / 1024} KiB`;
  return null;
}

/**
 * Why the app would refuse `environment`, a launch's variables, or null: what the page checks before it sends one
 * (terminalSessionLaunchProblem) and what HivemindKit's LaunchEnvironment checks again. Never quotes a value.
 */
export function launchEnvironmentProblem(environment: unknown): string | null {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) return "Environment variables must be an object";
  const entries = Object.entries(environment as Record<string, unknown>);
  if (entries.length === 0) return "Environment variables must name at least one variable";
  if (entries.length > LAUNCH_ENVIRONMENT_LIMITS.variables) return `At most ${LAUNCH_ENVIRONMENT_LIMITS.variables} environment variables`;
  let total = 0;
  for (const [name, value] of entries) {
    const nameProblem = launchEnvironmentNameProblem(name);
    if (nameProblem) return `Environment variables: ${nameProblem}`;
    if (typeof value !== "string") return `Environment variables: ${name} must be a string`;
    const valueProblem = launchEnvironmentValueProblem(value);
    if (valueProblem) return `Environment variables: ${name}: ${valueProblem}`;
    total += utf8Length(name) + 1 + utf8Length(value);
  }
  if (total > LAUNCH_ENVIRONMENT_LIMITS.totalBytes) {
    return `Environment variables come to more than ${LAUNCH_ENVIRONMENT_LIMITS.totalBytes / 1024} KiB`;
  }
  return null;
}

export type ParsedLaunchEnvironment = {
  /** The variables, in the order they were first written; the last line of a name wins. */
  environment: Record<string, string>;
  /** Names only: why a line was refused. Empty when the field can be launched. */
  errors: string[];
  /** Names only: what was accepted but may surprise (a name set twice). */
  warnings: string[];
};

/**
 * The field's text: one `NAME=value` per line; blank lines and lines starting with `#` are skipped. The value is
 * everything after the first `=`, literally (no escapes, no expansion), except that one pair of matching single or
 * double quotes around all of it is dropped. A name set twice keeps its last value, with a warning. Messages name
 * lines and variables, never a value.
 */
export function parseLaunchEnvironment(text: string): ParsedLaunchEnvironment {
  const environment: Record<string, string> = {};
  const lines = new Map<string, number[]>();
  const errors: string[] = [];
  text.split(/\r\n|\n|\r/).forEach((raw, index) => {
    const line = raw.replace(/^[ \t]+/, "");
    const at = `Line ${index + 1}`;
    if (!line || line.startsWith("#")) return;
    const equals = line.indexOf("=");
    if (equals < 0) {
      errors.push(`${at}: expected NAME=value`);
      return;
    }
    const name = line.slice(0, equals);
    let value = line.slice(equals + 1);
    if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0]) value = value.slice(1, -1);
    const problem = launchEnvironmentNameProblem(name) ?? launchEnvironmentValueProblem(value);
    if (problem) {
      errors.push(`${at}: ${problem}`);
      return;
    }
    // Deleting first moves a redefined name to where it was last set, as the shell would see the lines.
    delete environment[name];
    environment[name] = value;
    lines.set(name, [...(lines.get(name) ?? []), index + 1]);
  });
  const warnings = [...lines].filter(([, at]) => at.length > 1)
    .map(([name, at]) => `${name} is set on lines ${at.join(", ")}; line ${at.at(-1)} wins`);
  if (!errors.length) {
    const count = Object.keys(environment).length;
    if (count > LAUNCH_ENVIRONMENT_LIMITS.variables) {
      errors.push(`At most ${LAUNCH_ENVIRONMENT_LIMITS.variables} variables (${count} here)`);
    } else if (count) {
      const total = Object.entries(environment).reduce((sum, [name, value]) => sum + utf8Length(name) + 1 + utf8Length(value), 0);
      if (total > LAUNCH_ENVIRONMENT_LIMITS.totalBytes) errors.push(`The variables come to more than ${LAUNCH_ENVIRONMENT_LIMITS.totalBytes / 1024} KiB`);
    }
  }
  return { environment, errors, warnings };
}

/**
 * The copied command's prefix: `NAME='value' NAME2='value' `, each value single-quoted so nothing in it is expanded,
 * or "" for none. Only for text a person pastes into a terminal; the apps never put a value in a command line.
 */
export function launchEnvironmentPrefix(environment: Record<string, string> | null | undefined): string {
  const entries = Object.entries(environment ?? {});
  if (entries.some(([name, value]) => launchEnvironmentNameProblem(name) || launchEnvironmentValueProblem(value))) {
    throw new Error("Environment variables are not valid");
  }
  return entries.map(([name, value]) => `${name}=${shSingleQuote(value)} `).join("");
}
