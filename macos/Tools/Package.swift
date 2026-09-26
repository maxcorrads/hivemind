// swift-tools-version: 5.9
import PackageDescription

// Build tools for the Apple apps, fetched and built by SwiftPM so nothing
// comes from Homebrew. Only XcodeGen for now, which generates
// ios/Hivemind.xcodeproj from ios/project.yml:
//
//   swift run --package-path macos/Tools xcodegen generate --spec ios/project.yml
//
// The version is exact and Package.resolved is committed, so every machine
// and CI builds the same XcodeGen and the same dependencies of it. Bump it
// here and run `swift package --package-path macos/Tools update`.
let package = Package(
  name: "HivemindTools",
  platforms: [.macOS(.v13)],
  dependencies: [
    .package(url: "https://github.com/yonaskolb/XcodeGen.git", exact: "2.46.0"),
  ],
  // No targets: `swift run xcodegen` builds and runs the dependency's
  // executable product directly.
  targets: []
)
