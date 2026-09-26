// The tmux session an agent launched from Hivemind runs in. Hivemind Server.app's
// terminal broker names sessions (macos/Sources/HivemindKit/SessionName.swift)
// and sets HIVEMIND_TMUX_SESSION in each one; `hivemind mcp` reports it on join
// and the UI shows it as agent.terminalSession. It is a label only: the server
// never runs, opens or kills anything by it. docs/terminal-broker.md.

/** The same pattern SessionName.pattern checks on the native side. */
export const TERMINAL_SESSION_PATTERN = /^hm-[a-z0-9][a-z0-9-]{0,78}$/;

/** The environment variable a launched session's shell carries its own name in. */
export const TERMINAL_SESSION_ENV = "HIVEMIND_TMUX_SESSION";

/** The value when it is a Hivemind session name, else null (never thrown on). */
export function terminalSessionName(value: unknown): string | null {
  return typeof value === "string" && TERMINAL_SESSION_PATTERN.test(value) ? value : null;
}

/**
 * The join field for the session this process runs in, read from its environment. Outside a Hivemind session the
 * field is left out (the server then clears the agent's label), so a server older than the field still accepts it.
 */
export function terminalSessionFields(env: Readonly<Record<string, string | undefined>>): { terminalSession?: string } {
  const session = terminalSessionName(env[TERMINAL_SESSION_ENV]);
  return session ? { terminalSession: session } : {};
}
