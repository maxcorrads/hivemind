import Foundation

/// The `hivemind` wrapper "Install command-line tool" writes: a shell script
/// that runs the app's bundled Node with the bundled CLI. It points at the
/// app's current location, so moving the app means reinstalling; the script
/// says so instead of failing with a bare "No such file".
public enum CommandLineTool {
  public static func script(server: BundledServer, discoveryFile: URL) -> String {
    let node = shellQuoted(server.node.path)
    let cli = shellQuoted(server.cli.path)
    let discovery = shellQuoted(discoveryFile.path)
    return """
    #!/bin/sh
    # Installed by Hivemind Server.app: runs the hivemind CLI with the app's bundled Node.js.
    node=\(node)
    cli=\(cli)
    if [ ! -x "$node" ] || [ ! -f "$cli" ]; then
      echo "hivemind: Hivemind Server.app has moved or was removed; reinstall the command-line tool from its menu." >&2
      exit 127
    fi
    # Follow the port and data folder of the app's running server, unless the
    # shell chose its own. A home with JSON escapes in it is left alone.
    if [ -f \(discovery) ]; then
      if [ -z "${HIVEMIND_URL:-}" ]; then
        port=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' \(discovery) | head -n 1)
        if [ -n "$port" ]; then HIVEMIND_URL="http://127.0.0.1:$port"; export HIVEMIND_URL; fi
      fi
      if [ -z "${HIVEMIND_HOME:-}" ]; then
        home=$(sed -n 's/.*"home"[[:space:]]*:[[:space:]]*"\\([^"\\]*\\)".*/\\1/p' \(discovery) | head -n 1)
        if [ -n "$home" ]; then HIVEMIND_HOME="$home"; export HIVEMIND_HOME; fi
      fi
    fi
    exec "$node" "$cli" "$@"

    """
  }

  /// POSIX single quoting: the only character that needs care is ' itself.
  public static func shellQuoted(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }

  /// An AppleScript string literal (for `do shell script`).
  public static func appleScriptLiteral(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
  }

  /// The shell command that installs an already written wrapper at `destination`.
  public static func installCommand(from source: URL, to destination: URL) -> String {
    let folder = destination.deletingLastPathComponent().path
    return "/bin/mkdir -p \(shellQuoted(folder)) && /usr/bin/install -m 0755 \(shellQuoted(source.path)) \(shellQuoted(destination.path))"
  }

  /// AppleScript that runs `installCommand` behind the system administrator
  /// prompt; only the "Install command-line tool" click runs it, for
  /// destinations the user cannot write (e.g. /usr/local/bin).
  public static func adminInstallAppleScript(from source: URL, to destination: URL) -> String {
    "do shell script \(appleScriptLiteral(installCommand(from: source, to: destination))) with administrator privileges"
  }
}
