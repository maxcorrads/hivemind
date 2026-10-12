import Foundation

// The Claude status-line tap (docs/accounts.md, "Claude status-line tap"). Before each created Claude launch with an
// account, the broker writes the account's settings file and the tap script, and sets HIVEMIND_CLAUDE_SETTINGS to the
// file, which the launch command passes to `--settings`. Its `statusLine` runs the tap: it saves Claude's status-line
// input (which carries `rate_limits`, ClaudeUsage.parseStatusLine) as `<id>/statusline.json`, then runs the account's own
// `statusLine.command` on the same input and prints its output. Its `StopFailure` hook (matcher `rate_limit`) writes the
// time to `<id>/limit-error`. Nothing here reads a login or `.claude.json`; the tap reads only `statusLine.command` of
// the account's `settings.json`, each time it runs.

extension HivemindPaths {
  /// A folder per account for its usage files, and the Claude status-line tap (ClaudeStatusTap).
  public var accounts: URL { appSupport.appendingPathComponent("accounts", isDirectory: true) }
}

/// The tap's files under `folder` (HivemindPaths.accounts): the script, and a folder per account named by its id.
public struct ClaudeStatusTap: Equatable, Sendable {
  /// What the broker sets to the settings file. The launch command of exactly `claude` passes it to `--settings` only
  /// when it is set (CLAUDE_SETTINGS_FLAG in src/shared/launch-prompt.ts). HIVEMIND_-named, so no launch can set it.
  public static let variable = "HIVEMIND_CLAUDE_SETTINGS"

  public let folder: URL

  public init(folder: URL) {
    self.folder = folder
  }

  /// Run with /bin/sh, so it needs no execute bit.
  public var script: URL { folder.appendingPathComponent("statusline-tap.sh") }

  /// `<folder>/<id>`, or nil for an id that is not a plain file name (letters, digits, `-` and `_`; the server's ids
  /// are UUIDs), so no id can name a folder elsewhere.
  public func accountFolder(_ id: String) -> URL? {
    let plain = id.utf8.allSatisfy { byte in
      (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte) || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte)
        || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) || byte == UInt8(ascii: "-") || byte == UInt8(ascii: "_")
    }
    guard plain, (1...LaunchAccount.maxIDBytes).contains(id.utf8.count) else { return nil }
    return folder.appendingPathComponent(id, isDirectory: true)
  }

  /// Claude's latest status-line input for the account, as the tap saved it.
  public func statusLineFile(_ id: String) -> URL? { accountFolder(id)?.appendingPathComponent("statusline.json") }

  /// When a `StopFailure` hook last saw a `rate_limit` error under the account: Unix seconds, one line.
  public func limitErrorFile(_ id: String) -> URL? { accountFolder(id)?.appendingPathComponent("limit-error") }

  /// The settings file of a Claude `account`, or nil for an id that names no folder. `statusLine` runs the tap's
  /// `status` with the account's folder and its own `settings.json` (in its shadow, its shared tree or ~/.claude, with
  /// a leading `~/` expanded with `home`); a `StopFailure` hook with matcher `rate_limit` runs its `limit-error`. Each
  /// path is single-quoted for the shell Claude runs a command in.
  public func settings(for account: LaunchAccount, home: String) -> Data? {
    guard let accountFolder = accountFolder(account.id) else { return nil }
    let own = ClaudeLiveSessions.directory(of: account, home: home) + "/settings.json"
    let tap = "/bin/sh " + TerminalScript.shellQuoted(script.path)
    let quotedFolder = TerminalScript.shellQuoted(accountFolder.path)
    let settings: [String: Any] = [
      "statusLine": ["type": "command", "command": "\(tap) status \(quotedFolder) \(TerminalScript.shellQuoted(own))"],
      "hooks": [
        "StopFailure": [["matcher": "rate_limit", "hooks": [["type": "command", "command": "\(tap) limit-error \(quotedFolder)"]]]],
      ],
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: settings, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    else { return nil }
    return data + Data("\n".utf8)
  }

  /// Writes the script and `account`'s settings file, each 0600 through a temporary file and a rename, in folders
  /// created or tightened to 0700, and returns the settings file's path. Throws for an account that is not Claude's, an
  /// id that names no folder, or a folder or file that cannot be written.
  public func install(for account: LaunchAccount, home: String) throws(BrokerFiles.Failure) -> String {
    guard account.driver == .claude else { throw BrokerFiles.Failure("Only a Claude account has a status-line tap") }
    guard let accountFolder = accountFolder(account.id), let settings = settings(for: account, home: home) else {
      throw BrokerFiles.Failure("The id of the account \(account.label) cannot name a folder")
    }
    try BrokerFiles.preparePrivateFolder(folder)
    try BrokerFiles.writePrivately(Data(Self.scriptText.utf8), to: script)
    try BrokerFiles.preparePrivateFolder(accountFolder)
    let file = accountFolder.appendingPathComponent("settings.json")
    try BrokerFiles.writePrivately(settings, to: file)
    return file.path
  }

  /// The tap. `status` keeps the input whole (ClaudeUsage reads only `rate_limits` from it) and chains with
  /// `/bin/sh -c`, in Claude's folder and environment; its exit status is the chained command's. Every write goes to a
  /// temporary file in the account folder, then a rename: a reader sees the old file or the new one. A missing folder
  /// writes nothing, and a missing, unreadable or non-string `statusLine.command` chains nothing.
  public static let scriptText = #"""
    # Hivemind's Claude status-line tap (docs/accounts.md, "Claude status-line tap"). Hivemind Server.app writes this
    # file before each Claude launch with an account; changes here are overwritten.
    #
    #   status <account folder> <settings.json>: saves the status-line input as <account folder>/statusline.json, then
    #     runs the statusLine.command of <settings.json>, the account's own, on the same input and prints its output.
    #   limit-error <account folder>: writes the time, in Unix seconds, to <account folder>/limit-error.
    # mktemp makes each file 0600; the umask stays Claude's, for the chained command.
    case $1 in
    status)
      input=$(/bin/cat)
      if temporary=$(/usr/bin/mktemp "$2/.statusline.json.XXXXXX" 2>/dev/null); then
        printf '%s\n' "$input" > "$temporary" && /bin/mv -f "$temporary" "$2/statusline.json" || /bin/rm -f "$temporary"
      fi
      chained=$(/usr/bin/plutil -extract statusLine.command raw -expect string -o - "$3" 2>/dev/null) || exit 0
      printf '%s\n' "$input" | /bin/sh -c "$chained"
      ;;
    limit-error)
      /bin/cat > /dev/null
      if temporary=$(/usr/bin/mktemp "$2/.limit-error.XXXXXX" 2>/dev/null); then
        /bin/date +%s > "$temporary" && /bin/mv -f "$temporary" "$2/limit-error" || /bin/rm -f "$temporary"
      fi
      ;;
    esac

    """#
}
