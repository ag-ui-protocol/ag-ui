// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

// Git URL entry point. Keep products and dependencies aligned with
// sdks/community/swift/Package.swift, which supports SDK-local development.
import PackageDescription

let package = Package(
    name: "AGUISwift",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "AGUICore",
            targets: ["AGUICore"]),
        .library(
            name: "AGUIClient",
            targets: ["AGUIClient"]),
        .library(
            name: "AGUIAgentSDK",
            targets: ["AGUIAgentSDK"]),
        .library(
            name: "AGUITools",
            targets: ["AGUITools"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-docc-plugin", from: "1.0.0"),
    ],
    targets: [
        .target(
            name: "AGUICore",
            dependencies: [],
            path: "sdks/community/swift/Sources/AGUICore"),
        .target(
            name: "AGUIClient",
            dependencies: ["AGUICore"],
            path: "sdks/community/swift/Sources/AGUIClient"),
        .target(
            name: "AGUIAgentSDK",
            dependencies: ["AGUICore", "AGUIClient", "AGUITools"],
            path: "sdks/community/swift/Sources/AGUIAgentSDK"),
        .target(
            name: "AGUITools",
            dependencies: ["AGUICore"],
            path: "sdks/community/swift/Sources/AGUITools"),
        .testTarget(
            name: "AGUICoreTests",
            dependencies: ["AGUICore"],
            path: "sdks/community/swift/Tests/AGUICoreTests"),
        .testTarget(
            name: "AGUIClientTests",
            dependencies: ["AGUIClient"],
            path: "sdks/community/swift/Tests/AGUIClientTests"),
        .testTarget(
            name: "AGUIAgentSDKTests",
            dependencies: ["AGUIAgentSDK", "AGUIClient", "AGUITools"],
            path: "sdks/community/swift/Tests/AGUIAgentSDKTests"),
        .testTarget(
            name: "AGUIToolsTests",
            dependencies: ["AGUITools"],
            path: "sdks/community/swift/Tests/AGUIToolsTests"),
    ]
)
