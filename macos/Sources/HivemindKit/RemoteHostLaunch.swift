import Foundation

// Launches, session lists and kills on a remote host (docs/remote-hosts.md#launch). The broker does on a host what it
// does here, over the host's master connection (BrokerRemoteHosts): each step is one `/bin/sh` script run with
// `ssh … <host> /bin/sh -c '<script>'`, built here from quoted values only, and what it prints is read back from marker
// lines, so the host's shell startup files can print what they like around them. Secrets go on the script's stdin,
// never in it. Nothing here runs anything: the broker runs the scripts, and the tests run them with a fake ssh.
//
//   probe     the host's home and tmux, and its Hivemind sessions (tmux -L hivemind list-sessions)
//   prepare   clones a missing project folder from this Mac's origin (read from stdin), then reads the host's facts
//             with its own perl: the folder, the Codex writer lock, Claude's live sessions, the project's Claude
//             settings, the shadow account's files and the account's login (its check, and for Claude the digest
//             of its account; RemoteHostAccounts.swift)
//   start     applies the shadow's links, puts a Codex account's MCP block in its config.toml, installs the Claude
//             status-line tap, writes the launch file from stdin (0600, O_EXCL, in the host's launch-secrets folder)
//             and runs the same TmuxCommand there
//   kill      tmux kill-session on the host

/// A configured host as the broker sees it.
public struct BrokerRemoteHost: Equatable, Sendable {
  public let id: String
  public let label: String
  /// The connection is up and the host's runtime is this app's: the host takes launches and its sessions are listed.
  public let ready: Bool
  /// The host's runtime folder relative to its home (RemoteRuntime.remoteFolder): its tmux.conf is the one the host's
  /// Hivemind tmux server loads. Nil when this app has no bundled runtime.
  public let runtimeFolder: String?

  public init(id: String, label: String, ready: Bool, runtimeFolder: String?) {
    self.id = id
    self.label = label
    self.ready = ready
    self.runtimeFolder = runtimeFolder
  }
}

/// The hosts the broker launches on and lists: HostsService in Server.app, a fake in the tests.
@MainActor public protocol BrokerRemoteHosts: AnyObject {
  /// Every configured host, ready or not, in hosts.json's order.
  var brokerHosts: [BrokerRemoteHost] { get }
  /// Runs `script` with /bin/sh on host `id` over its master, `stdin` on its standard input, for at most `timeout`.
  func run(onHost id: String, script: String, stdin: Data, timeout: TimeInterval) async -> SSHResult
  /// The same, with the output of the local command `input` on its standard input (a `tar` of this Mac's files).
  func run(onHost id: String, script: String, input: LaunchSpec, timeout: TimeInterval) async -> SSHResult
}

extension BrokerRemoteHosts {
  /// Hosts that cannot take a copy of this Mac's files refuse it.
  public func run(onHost id: String, script: String, input: LaunchSpec, timeout: TimeInterval) async -> SSHResult {
    SSHResult(status: SSHResult.launchFailed, stderr: "This host cannot take a copy of this Mac's files")
  }
}

/// Where a host script looks for tmux: the Homebrew locations, then the PATH of the host's shell, as TmuxLocator does
/// here. The tests give a fake tmux and no PATH search, so no script of theirs can reach a real tmux server.
public struct RemoteTmuxLookup: Equatable, Sendable {
  public var candidates: [String]
  public var searchPath: Bool

  public init(candidates: [String], searchPath: Bool) {
    self.candidates = candidates
    self.searchPath = searchPath
  }

  public static let standard = RemoteTmuxLookup(candidates: TmuxLocator.candidates, searchPath: true)
}

/// What a probe found on a host.
public struct RemoteHostProbe: Equatable, Sendable {
  /// The host user's home, which a launch's `~/` paths expand with there.
  public let home: String
  /// The host's tmux, or nil when it has none.
  public let tmux: String?
  /// The host's Hivemind sessions, each tagged with the host; a failure when its tmux could not list them.
  public let sessions: Result<[BrokerSession], BrokerProtocolError>
}

/// The facts a launch reads on a host before it starts anything there (`RemoteHostScripts.prepare`).
public struct RemoteFactsRequest: Codable, Equatable, Sendable {
  public struct CodexLock: Codable, Equatable, Sendable {
    public let directory: String
    public let thread: String
  }

  public struct Claude: Codable, Equatable, Sendable {
    public let directories: [String]
  }

  public struct Shadow: Codable, Equatable, Sendable {
    public let home: String
    public let shadow: String
    public let driver: String
  }

  /// Where an account's login lives on the host (AccountLogin): its login check, and for Claude its identity.
  public struct Login: Codable, Equatable, Sendable {
    public let driver: String
    public let directory: String
    public let configFile: String?

    public init(_ login: AccountLogin, driver: LaunchAccount.Driver) {
      self.driver = driver.rawValue
      directory = login.directory
      configFile = login.configFile
    }
  }

  public var cwd: String
  public var codexLock: CodexLock?
  public var claude: Claude?
  /// The project's Claude settings files whose `apiKeyHelper` and `env` names are read.
  public var projectSettings: [String]?
  public var shadow: Shadow?
  public var login: Login?

  public init(cwd: String, codexLock: CodexLock? = nil, claude: Claude? = nil, projectSettings: [String]? = nil, shadow: Shadow? = nil,
              login: Login? = nil) {
    self.cwd = cwd
    self.codexLock = codexLock
    self.claude = claude
    self.projectSettings = projectSettings
    self.shadow = shadow
    self.login = login
  }
}

/// What the host's perl answered. No value of a file is in it but the names and keys the checks compare.
public struct RemoteFacts: Codable, Equatable, Sendable {
  public struct Folder: Codable, Equatable, Sendable {
    public let directory: Bool
    public let real: String?
  }

  /// One `sessions/<pid>.json` of a Claude config folder: the five keys ClaudeLiveSessions reads, the record's folder
  /// resolved, and the start time of its process when it runs.
  public struct ClaudeRecord: Codable, Equatable, Sendable {
    public let directory: Int
    public let pid: Int64
    public let sessionId: String
    public let procStart: String?
    public let pidDomain: String?
    public let cwd: String?
    public let cwdReal: String?
    public let started: String?
  }

  public struct ClaudeSessions: Codable, Equatable, Sendable {
    public let records: [ClaudeRecord]?
    public let error: String?
  }

  public struct ProjectSettings: Codable, Equatable, Sendable {
    public let path: String
    public let apiKeyHelper: Bool
    public let env: [String]
  }

  /// An account's login on the host: the layout's check, the login file's `dev:ino:size:mtime` (or `none`), and for
  /// Claude the digest of `oauthAccount.accountUuid`. Never a login's contents.
  public struct Login: Codable, Equatable, Sendable {
    public let loggedIn: Bool
    public let stamp: String
    public let identity: String?
  }

  public let cwd: Folder
  /// `open`, `free`, or `error:<reason>`.
  public let codexLock: String?
  public let claude: ClaudeSessions?
  public let projectSettings: [ProjectSettings]?
  public let shadow: ShadowFacts?
  public let login: Login?
}

/// What a prepare script did.
public enum RemotePrepared: Equatable, Sendable {
  /// The facts, and whether the project folder was cloned first.
  case facts(RemoteFacts, cloned: Bool)
  /// The clone failed; git's last line.
  case cloneFailed(String)
  case failed(String)
}

/// What a start script did.
public struct RemoteStarted: Equatable, Sendable {
  /// A step before tmux refused, naming why; nothing was started.
  public let error: String?
  /// The tap was asked for and written (its variable stayed in the launch file).
  public let tap: Bool?
  /// tmux's exit status, and whether the session runs now (it may have been another launch's).
  public let status: Int32
  public let started: Bool
  public let duplicate: Bool
  /// tmux's first line.
  public let said: String?
  /// The Codex home's MCP block could not be written.
  public var mcpFailed = false
}

/// The scripts, for one host's runtime.
public struct RemoteHostScripts: Sendable {
  /// Where the host's Hivemind folder is, relative to its home (as here).
  public static let supportFolder = "Library/Application Support/Hivemind"
  /// The longest a probe, a kill, a prepare without a clone, and a start may take.
  public static let stepTimeout: TimeInterval = 30
  /// A clone may take this long.
  public static let cloneTimeout: TimeInterval = 10 * 60

  public let runtimeFolder: String
  public let tmux: RemoteTmuxLookup

  public init(runtimeFolder: String, tmux: RemoteTmuxLookup = .standard) {
    self.runtimeFolder = runtimeFolder
    self.tmux = tmux
  }

  private static func q(_ value: String) -> String { TerminalScript.shellQuoted(value) }

  /// Homebrew first, as the app's own PATH has it: the host user's non-interactive shell often has only the system's.
  private static let path = "PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; export PATH\n"

  /// The host's tmux.conf (installed with the runtime) under `home`.
  public func configPath(home: String) -> String { "\(home)/\(runtimeFolder)/tmux.conf" }

  /// The tmux of every later step: the host's executable and its runtime's config.
  public func tmuxCommand(_ probe: RemoteHostProbe) -> TmuxCommand? {
    probe.tmux.map { TmuxCommand(executable: $0, configPath: configPath(home: probe.home)) }
  }

  // MARK: probe

  public var probe: String {
    var script = Self.path + "tmux=\nfor candidate in \(tmux.candidates.map(Self.q).joined(separator: " ")); do\n"
      + "  if [ -x \"$candidate\" ]; then tmux=$candidate; break; fi\ndone\n"
    if tmux.searchPath { script += "if [ -z \"$tmux\" ]; then tmux=$(command -v tmux 2>/dev/null) || tmux=; fi\n" }
    let list = (["-u", "-L", TmuxCommand.socketName, "-f"].map(Self.q) + ["\"$HOME\"/\(Self.q(runtimeFolder + "/tmux.conf"))"]
      + ["list-sessions", "-F", TmuxCommand.listFormat].map(Self.q)).joined(separator: " ")
    script += """
      printf 'hivemind-home %s\\n' "$HOME"
      printf 'hivemind-tmux %s\\n' "$tmux"
      if [ -n "$tmux" ]; then
        list=$("$tmux" \(list) 2>&1)
        printf 'hivemind-list %s\\n' "$?"
        printf '%s\\n' "$list"
      fi
      """
    return script
  }

  /// What a probe printed on host `id`, or nil when it printed no home.
  public static func parseProbe(_ output: String, host id: String) -> RemoteHostProbe? {
    let lines = output.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
    func value(_ marker: String) -> String? {
      lines.last { $0.hasPrefix(marker + " ") }.map { String($0.dropFirst(marker.count + 1)) }
    }
    guard let home = value("hivemind-home"), home.hasPrefix("/") else { return nil }
    let tmux = value("hivemind-tmux").flatMap { $0.isEmpty ? nil : $0 }
    guard tmux != nil, let marker = lines.lastIndex(where: { $0.hasPrefix("hivemind-list ") }) else {
      return RemoteHostProbe(home: home, tmux: tmux, sessions: .success([]))
    }
    let listed = lines[(marker + 1)...].joined(separator: "\n")
    let sessions: Result<[BrokerSession], BrokerProtocolError>
    if lines[marker] == "hivemind-list 0" {
      sessions = .success(TmuxCommand.parseSessions(listed).map { $0.on(host: id) })
    } else if TmuxCommand.isNoServer(stderr: listed) {
      sessions = .success([])
    } else {
      let first = listed.split(whereSeparator: \.isNewline).first.map(String.init) ?? "tmux list-sessions failed"
      sessions = .failure(BrokerProtocolError(.tmuxFailed, String(first.prefix(200))))
    }
    return RemoteHostProbe(home: home, tmux: tmux, sessions: sessions)
  }

  // MARK: kill

  public static func kill(_ name: SessionName, tmux: TmuxCommand) -> String {
    let argv = ([tmux.executable] + tmux.killSession(name)).map(q).joined(separator: " ")
    return "out=$(\(argv) 2>&1)\nprintf 'hivemind-status %s\\n' \"$?\"\nprintf '%s\\n' \"$out\"\n"
  }

  /// A kill's tmux status and what tmux said, as a TmuxResult; nil when the script printed no status.
  public static func parseKill(_ output: String) -> TmuxResult? {
    let lines = output.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
    guard let marker = lines.lastIndex(where: { $0.hasPrefix("hivemind-status ") }),
          let status = Int32(lines[marker].dropFirst("hivemind-status ".count)) else { return nil }
    return TmuxResult(status: status, stdout: "", stderr: lines[(marker + 1)...].joined(separator: "\n"))
  }

  // MARK: prepare

  /// Clones the project folder when it is missing and stdin's first line names an origin, then prints the facts of
  /// the request on the rest of stdin. Credentials for the clone are the host's own; git may not prompt.
  public static func prepare(cwd: String) -> String {
    path + """
      cwd=\(q(cwd))
      IFS= read -r origin || origin=
      if [ ! -e "$cwd" ] && [ ! -L "$cwd" ] && [ -n "$origin" ]; then
        parent=${cwd%/*}
        [ -n "$parent" ] || parent=/
        if out=$(mkdir -p -- "$parent" 2>&1 && GIT_TERMINAL_PROMPT=0 git clone --quiet -- "$origin" "$cwd" 2>&1); then
          echo hivemind-cloned
        else
          printf 'hivemind-clone-failed %s\\n' "$(printf '%s\\n' "$out" | tail -n 1)"
          exit 0
        fi
      fi
      echo hivemind-facts
      exec /usr/bin/perl -e \(q(factsProgram))

      """
  }

  /// stdin of a prepare: the origin's line, then the request.
  public static func prepareInput(origin: String?, request: RemoteFactsRequest) -> Data {
    let line = origin.map { $0.contains(where: \.isNewline) ? "" : $0 } ?? ""
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return Data((line + "\n").utf8) + ((try? encoder.encode(request)) ?? Data("{}".utf8))
  }

  public static func parsePrepare(_ output: String) -> RemotePrepared {
    let lines = output.split(whereSeparator: \.isNewline).map(String.init)
    if let failed = lines.last(where: { $0.hasPrefix("hivemind-clone-failed") }) {
      let reason = failed.dropFirst("hivemind-clone-failed".count).trimmingCharacters(in: .whitespaces)
      return .cloneFailed(reason.isEmpty ? "git clone failed" : String(reason.prefix(200)))
    }
    guard let marker = lines.lastIndex(of: "hivemind-facts") else {
      return .failed(SSHTransport.reason(in: lines) ?? "the host printed no facts")
    }
    guard let json = lines[(marker + 1)...].last(where: { $0.hasPrefix("{") }),
          let facts = try? JSONDecoder().decode(RemoteFacts.self, from: Data(json.utf8)) else {
      return .failed(SSHTransport.reason(in: Array(lines[(marker + 1)...])) ?? "the host's facts could not be read")
    }
    return .facts(facts, cloned: lines[..<marker].contains("hivemind-cloned"))
  }

  /// The host's perl reads the facts of a request on stdin and prints them as one JSON line. It follows the checks of
  /// CodexThreadLock, ClaudeLiveSessions, TerminalBroker.projectOverride and LocalShadowFiles, and reads of each file
  /// only what they compare: names, kinds, link targets, `cleanupPeriodDays`, the credential store line, whether a
  /// login is there, the five keys of a session record. macOS ships perl and its JSON::PP.
  static let factsProgram = #"""
    use strict; use warnings;
    use Fcntl qw(:flock :mode O_RDWR O_CREAT);
    use Cwd qw(realpath);
    use JSON::PP;
    use Digest::SHA qw(sha256_hex);
    my $json = JSON::PP->new->canonical;
    my $text = do { local $/; <STDIN> };
    my $request = $json->decode(defined $text && length $text ? $text : '{}');
    my %out;
    sub kind {
      my ($path) = @_;
      my @info = lstat($path);
      unless (@info) { return ($!{ENOENT} || $!{ENOTDIR}) ? 'none' : "error:$!"; }
      my $mode = $info[2];
      return S_ISDIR($mode) ? 'dir' : S_ISREG($mode) ? 'file' : S_ISLNK($mode) ? 'link' : 'other';
    }
    sub entry {
      my ($path) = @_;
      my %entry = (kind => kind($path));
      $entry{link} = readlink($path) if $entry{kind} eq 'link';
      my $real = realpath($path);
      $entry{real} = $real if defined $real;
      if ($entry{kind} eq 'dir') {
        my %entries;
        if (opendir(my $dh, $path)) {
          for my $name (readdir($dh)) {
            next if $name eq '.' || $name eq '..';
            my %child = (kind => kind("$path/$name"));
            $child{link} = readlink("$path/$name") if $child{kind} eq 'link';
            $entries{$name} = \%child;
          }
          closedir($dh);
          $entry{entries} = \%entries;
        } else { $entry{kind} = "error:$!"; }
      }
      return \%entry;
    }
    sub read_json {
      my ($path) = @_;
      return undef unless -e $path;
      open(my $fh, '<', $path) or return 0;
      my $data = do { local $/; <$fh> };
      close($fh);
      my $value = eval { JSON::PP->new->decode(defined $data ? $data : '') };
      return ref($value) eq 'HASH' ? $value : 0;
    }
    sub cleanup {
      my ($path) = @_;
      my $settings = read_json($path);
      return 'default' unless defined $settings;
      return 'invalid' unless ref $settings;
      my $days = $settings->{cleanupPeriodDays};
      return 'default' unless defined $days;
      return ref($days) && !JSON::PP::is_bool($days) ? $json->encode($days) : "$days";
    }
    sub codex_lock {
      my ($dir, $id) = @_;
      my $coordination = "$dir/.coordination.lock";
      my ($cf, $tf);
      unless (sysopen($cf, $coordination, O_RDWR | O_CREAT, 0600)) { return $!{ENOENT} ? 'free' : "error:Cannot check `$coordination`: $!"; }
      flock($cf, LOCK_EX) or return "error:Cannot check `$coordination`: $!";
      my $thread = "$dir/$id.lock";
      unless (sysopen($tf, $thread, O_RDWR)) { return $!{ENOENT} ? 'free' : "error:Cannot check `$thread`: $!"; }
      if (flock($tf, LOCK_EX | LOCK_NB)) { flock($tf, LOCK_UN); return 'free'; }
      return $!{EWOULDBLOCK} ? 'open' : "error:Cannot check `$thread`: $!";
    }
    my $cwd = $request->{cwd};
    $out{cwd} = { directory => (-d $cwd ? JSON::PP::true : JSON::PP::false) };
    my $real = realpath($cwd);
    $out{cwd}{real} = $real if defined $real;
    if (my $lock = $request->{codexLock}) { $out{codexLock} = codex_lock($lock->{directory}, $lock->{thread}); }
    if (my $claude = $request->{claude}) {
      my (@records, $error);
      my $dirs = $claude->{directories};
      DIR: for my $index (0 .. $#$dirs) {
        my $folder = "$dirs->[$index]/sessions";
        my $dh;
        unless (opendir($dh, $folder)) { next DIR if $!{ENOENT}; $error = "Cannot check `$folder`: $!"; last DIR; }
        for my $name (readdir($dh)) {
          next unless $name =~ /\A[0-9]+\.json\z/;
          open(my $fh, '<', "$folder/$name") or next;
          my $data = '';
          read($fh, $data, 65536);
          close($fh);
          my $record = eval { JSON::PP->new->decode($data) };
          next unless ref($record) eq 'HASH';
          my ($pid, $session) = ($record->{pid}, $record->{sessionId});
          next unless defined $pid && !ref($pid) && $pid =~ /\A-?[0-9]{1,10}\z/ && defined $session && !ref($session);
          my %item = (directory => $index + 0, pid => $pid + 0, sessionId => "$session");
          for my $key (qw(procStart pidDomain cwd)) { $item{$key} = "$record->{$key}" if defined $record->{$key} && !ref($record->{$key}); }
          if (defined $item{cwd}) { my $resolved = realpath($item{cwd}); $item{cwdReal} = $resolved if defined $resolved; }
          if ($pid > 1 && kill(0, $pid)) {
            my $started = `TZ=UTC LC_ALL=C /bin/ps -o lstart= -p $pid 2>/dev/null`;
            $started =~ s/\A\s+|\s+\z//g;
            $item{started} = $started if length $started;
          }
          push(@records, \%item);
        }
        closedir($dh);
      }
      $out{claude} = defined $error ? { error => $error } : { records => \@records };
    }
    if (my $files = $request->{projectSettings}) {
      my @found;
      for my $path (@$files) {
        my $settings = read_json($path);
        next unless ref $settings;
        push(@found, { path => $path, apiKeyHelper => (defined $settings->{apiKeyHelper} ? JSON::PP::true : JSON::PP::false),
                       env => (ref($settings->{env}) eq 'HASH' ? [sort keys %{$settings->{env}}] : []) });
      }
      $out{projectSettings} = \@found;
    }
    if (my $shadow = $request->{shadow}) {
      my ($home, $own) = ($shadow->{home}, $shadow->{shadow});
      my %facts = (paths => { $home => entry($home), $own => entry($own) },
                   cleanup => { "$home/settings.json" => cleanup("$home/settings.json"), "$own/settings.json" => cleanup("$own/settings.json") },
                   loggedIn => JSON::PP::false);
      if ($shadow->{driver} eq 'codex') {
        if (open(my $fh, '<', "$home/config.toml")) {
          while (my $line = <$fh>) {
            last if $line =~ /\A\s*\[/;
            if ($line =~ /\A\s*cli_auth_credentials_store\s*=\s*["']?(keyring|auto|ephemeral)["']?/) { $facts{credentialStore} = $1; last; }
          }
          close($fh);
        }
        $facts{loggedIn} = kind("$own/auth.json") eq 'file' ? JSON::PP::true : JSON::PP::false;
      } else {
        my $login = kind("$own/.credentials.json") eq 'file';
        if (!$login && kind("$own/.claude.json") eq 'file') { my $config = read_json("$own/.claude.json"); $login = ref($config) && exists $config->{oauthAccount}; }
        $facts{loggedIn} = $login ? JSON::PP::true : JSON::PP::false;
      }
      $out{shadow} = \%facts;
    }
    if (my $login = $request->{login}) {
      my ($dir, $config) = ($login->{directory}, $login->{configFile});
      my $file = $login->{driver} eq 'codex' ? "$dir/auth.json" : $config;
      my @info = stat($file);
      my %facts = (stamp => (@info ? "$info[0]:$info[1]:$info[7]:$info[9]" : 'none'), loggedIn => JSON::PP::false);
      if ($login->{driver} eq 'codex') {
        $facts{loggedIn} = kind($file) eq 'file' ? JSON::PP::true : JSON::PP::false;
      } else {
        my $data = kind($config) eq 'file' ? read_json($config) : undef;
        my $signed = kind("$dir/.credentials.json") eq 'file' || (ref($data) && exists $data->{oauthAccount});
        $facts{loggedIn} = $signed ? JSON::PP::true : JSON::PP::false;
        my $uuid = ref($data) && ref($data->{oauthAccount}) eq 'HASH' ? $data->{oauthAccount}{accountUuid} : undef;
        if (defined $uuid && !ref($uuid) && length $uuid) { my $text = "$uuid"; utf8::encode($text); $facts{identity} = sha256_hex($text); }
      }
      $out{login} = \%facts;
    }
    print $json->encode(\%out), "\n";
    """#

  // MARK: start

  /// A file the start script writes, 0600 through a temporary file and a rename, in 0700 folders: the tap's.
  public struct PrivateFile: Equatable, Sendable {
    public let path: String
    public let contents: String

    public init(path: String, contents: String) {
      self.path = path
      self.contents = contents
    }
  }

  /// Applies `actions`, writes `tapFiles` (a failure only drops the tap's variable from the launch file), writes the
  /// launch file at `file` from stdin, then runs `arguments` with `tmux`. A launch file nobody will read (tmux failed,
  /// or the name was another launch's) is deleted at once; leftovers older than 10 minutes go before each launch.
  public static func start(actions: [SnapshotShadowFiles.Action], tapFiles: [PrivateFile], file: LaunchEnvironmentFile?,
                           tmux: TmuxCommand, arguments: [String], name: SessionName, codexConfig: (path: String, block: String)? = nil) -> String {
    var script = path + "fail() { printf 'hivemind-error %s\\n' \"$1\"; exit 0; }\n" + RemoteAccountScripts.applying(actions, again: "launch again")
    // A Codex account's home gets this runtime's MCP block back when it differs (docs/remote-hosts.md#accounts); a
    // failure leaves the session to start with what the file has.
    if let codexConfig { script += RemoteAccountScripts.ensureCodexBlock(config: codexConfig.path, block: codexConfig.block) }
    var tap = "1"
    if !tapFiles.isEmpty {
      script += "tap=1\n"
      for written in tapFiles {
        let folder = (written.path as NSString).deletingLastPathComponent
        script += "if [ \"$tap\" = 1 ]; then\n"
          + "  if mkdir -p -m 700 -- \(q(folder)) && [ -d \(q(folder)) ] && [ ! -L \(q(folder)) ] && chmod 700 \(q(folder))"
          + " && temporary=$(mktemp \(q(folder + "/.hivemind.XXXXXX"))); then\n"
          + "    printf '%s' \(q(written.contents)) > \"$temporary\" && mv -f -- \"$temporary\" \(q(written.path)) || { rm -f -- \"$temporary\"; tap=0; }\n"
          + "  else tap=0; fi\nfi\n"
      }
      script += "printf 'hivemind-tap %s\\n' \"$tap\"\n"
      tap = "\"$tap\""
    }
    if let file {
      let folder = (file.path as NSString).deletingLastPathComponent
      script += "dir=\(q(folder))\n"
        + "[ -d \"$dir\" ] || mkdir -m 700 -- \"$dir\" 2>/dev/null\n"
        + "if [ -d \"$dir\" ] && [ ! -L \"$dir\" ] && [ -O \"$dir\" ] && chmod 700 \"$dir\"; then :; else fail \(q("`\(folder)` is not a private folder of this user's")); fi\n"
        + "find \"$dir\" -type f -mmin +\(Int(LaunchSecretStore.maxAge / 60)) -exec rm -f {} + 2>/dev/null\n"
        + "/usr/bin/perl -e \(q(writerProgram)) \(q(file.path)) \(tap) || fail \(q("Cannot write \(file.path)"))\n"
    }
    let run = ([tmux.executable] + arguments).map(q).joined(separator: " ")
    let check = ([tmux.executable] + tmux.hasSession(name)).map(q).joined(separator: " ")
    script += """
      out=$(\(run) 2>&1)
      status=$?
      started=1
      if [ "$status" -ne 0 ]; then \(check) >/dev/null 2>&1 || started=0; fi
      case $out in *"duplicate session"*) duplicate=1 ;; *) duplicate=0 ;; esac

      """
    if let file { script += "if [ \"$started\" = 0 ] || [ \"$duplicate\" = 1 ]; then rm -f -- \(q(file.path)); fi\n" }
    script += """
      printf 'hivemind-started %s %s %s\\n' "$status" "$started" "$duplicate"
      printf '%s\\n' "$out" | sed -n '1s/^/hivemind-tmux-said /p'

      """
    return script
  }

  /// Writes stdin to the launch file as LaunchSecretStore does here: O_CREAT | O_EXCL | O_NOFOLLOW at 0600, nothing
  /// left behind on failure. Its second argument 0 drops the tap's variable, whose settings file could not be written.
  static let writerProgram = #"""
    use strict;
    use Fcntl qw(O_WRONLY O_CREAT O_EXCL O_NOFOLLOW);
    my ($path, $tap) = @ARGV;
    my $data = do { local $/; <STDIN> };
    $data = '' unless defined $data;
    $data = join('', grep { !/\AHIVEMIND_CLAUDE_SETTINGS=/ } split(/^/, $data)) unless $tap;
    sysopen(my $fh, $path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or exit 1;
    chmod(0600, $path);
    my $ok = print {$fh} $data;
    $ok = close($fh) && $ok;
    unless ($ok) { unlink($path); exit 1; }
    """#

  public static func parseStart(_ output: String) -> RemoteStarted? {
    let lines = output.split(whereSeparator: \.isNewline).map(String.init)
    if let error = lines.last(where: { $0.hasPrefix("hivemind-error ") }) {
      return RemoteStarted(error: String(error.dropFirst("hivemind-error ".count)), tap: nil, status: 1, started: false,
                           duplicate: false, said: nil)
    }
    guard let line = lines.last(where: { $0.hasPrefix("hivemind-started ") }) else { return nil }
    let fields = line.split(separator: " ").dropFirst().map(String.init)
    guard fields.count == 3, let status = Int32(fields[0]) else { return nil }
    let tap = lines.last { $0.hasPrefix("hivemind-tap ") }.map { $0 == "hivemind-tap 1" }
    let said = lines.last { $0.hasPrefix("hivemind-tmux-said ") }.map { String($0.dropFirst("hivemind-tmux-said ".count).prefix(200)) }
    return RemoteStarted(error: nil, tap: tap, status: status, started: fields[1] == "1", duplicate: fields[2] == "1", said: said,
                         mcpFailed: lines.contains("hivemind-mcp-failed"))
  }
}
