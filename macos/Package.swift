// swift-tools-version: 6.0
import PackageDescription

// HivemindKit holds everything testable without AppKit, a network or a child
// process; the two apps are thin shells over it. It also builds for iOS, where
// the iOS app (ios/project.yml) links it; the two app executables import
// AppKit and are only ever built for macOS (macos/build.sh).
let package = Package(
  name: "HivemindMac",
  platforms: [.macOS(.v13), .iOS("26.0")],
  products: [
    .library(name: "HivemindKit", targets: ["HivemindKit"]),
    .executable(name: "Hivemind", targets: ["HivemindApp"]),
    .executable(name: "HivemindServer", targets: ["HivemindServerApp"]),
  ],
  targets: [
    .target(name: "HivemindKit"),
    .executableTarget(name: "HivemindApp", dependencies: ["HivemindKit"]),
    .executableTarget(name: "HivemindServerApp", dependencies: ["HivemindKit"]),
    .testTarget(name: "HivemindKitTests", dependencies: ["HivemindKit"]),
  ]
)
