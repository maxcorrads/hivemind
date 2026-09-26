import Foundation

/// Every bound of the remote gateway (docs/remote-access.md#limits). The
/// gateway is the authority; the iOS app checks the same numbers first only
/// to give a better message.
public enum GatewayLimits {
  // MARK: Listener

  /// Default TCP port of the gateway (the Node server's is 7420).
  public static let defaultPort = 7443
  /// Connections at once, all devices together.
  public static let maxConnections = 128
  /// Connections at once from one remote address.
  public static let maxConnectionsPerAddress = 48

  // MARK: Pairing

  /// A pairing code is valid this long after the QR code is shown.
  public static let pairingCodeLifetime: TimeInterval = 5 * 60
  /// Wrong codes before the pairing window is locked: the code shown is
  /// dropped and a new one needs "Pair a device…" again. At 128 bits a guess
  /// never succeeds; this only stops a device on the network from spamming.
  public static let maxPairingFailures = 5
  /// POST /_hivemind/pair attempts per remote address per minute.
  public static let pairingAttemptsPerMinute = 10
  /// Hosts in one pairing payload.
  public static let maxPairingHosts = 8
  /// Paired devices at once; pairing refuses more.
  public static let maxDevices = 32
  /// A device name (PairRequest.deviceName), in characters.
  public static let maxDeviceNameCharacters = 64
  /// The Mac name in a pairing payload and the Bonjour TXT record.
  public static let maxMacNameCharacters = 64
  /// A whole pairing link (hivemind-pair://…), in bytes: small enough for a
  /// QR code a phone camera reads at a glance.
  public static let maxPairingLinkBytes = 1024

  // MARK: Sessions

  /// Lifetime of a device session (the cookie's Max-Age). The app asks for a
  /// new one well before, and whenever a scene becomes active.
  public static let sessionLifetime: TimeInterval = 60 * 60
  /// The app renews its session once less than this is left.
  public static let sessionRenewBefore: TimeInterval = 30 * 60
  /// POST /_hivemind/session attempts per remote address per minute.
  public static let sessionAttemptsPerMinute = 30
  /// Live sessions per device; the oldest is dropped past this.
  public static let maxSessionsPerDevice = 8

  // MARK: HTTP

  /// A request head (request line and headers).
  public static let maxRequestHeadBytes = 32 * 1024
  public static let maxHeaderCount = 100
  /// The body of the gateway's own endpoints (/_hivemind/pair, /session).
  public static let maxGatewayBodyBytes = 4 * 1024
  /// A proxied request body: the Node server's own per-file limit
  /// (FILE_MAX_BYTES, 512 MiB, src/shared/types.ts) plus room for the
  /// multipart framing. The server enforces its own limits on top.
  public static let maxProxiedRequestBodyBytes: Int64 = 512 * 1024 * 1024 + 1024 * 1024
  /// A proxied response body (downloads): larger than any file the server
  /// stores, so only a runaway response is cut.
  public static let maxProxiedResponseBodyBytes: Int64 = 1024 * 1024 * 1024
  /// A request head must arrive within this.
  public static let requestHeadTimeout: TimeInterval = 15
  /// An idle keep-alive connection is closed after this.
  public static let idleTimeout: TimeInterval = 120

  // MARK: Broker over WebSocket

  /// One device → gateway broker message: one request frame.
  public static let maxBrokerMessageInBytes = BrokerLimits.maxRequestBytes
  /// One gateway → device broker message: one event frame. The iOS app's
  /// URLSessionWebSocketTask.maximumMessageSize must be at least this (its
  /// default is 1 MiB).
  public static let maxBrokerMessageOutBytes = BrokerLimits.maxEventBytes
  /// Broker connections per device.
  public static let maxBrokerConnectionsPerDevice = 8
}
