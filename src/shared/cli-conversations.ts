/** An agent's last CLI conversation, as Resume same employees can continue it (docs/terminal-broker.md). */
export type CliConversation = {
  cli: "claude" | "codex" | "cursor";
  /** The command that reaches this conversation's home: `claude2` for `~/.claude2`, `agent` for Cursor. */
  software: string;
  id: string;
  cwd: string | null;
  /** The transcript's last write, in ms. */
  at: number;
};
