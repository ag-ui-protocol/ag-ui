// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AGUISwift",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "AGUICore", targets: ["AGUICore"]),
        .library(name: "AGUIClient", targets: ["AGUIClient"]),
        .executable(name: "agui-dojo-chat", targets: ["agui-dojo-chat"]),
    ],
    targets: [
        .target(name: "AGUICore"),
        .target(name: "AGUIClient", dependencies: ["AGUICore"]),
        .executableTarget(name: "agui-dojo-chat", dependencies: ["AGUICore", "AGUIClient"]),
        .testTarget(name: "AGUICoreTests", dependencies: ["AGUICore"]),
        .testTarget(name: "AGUIClientTests", dependencies: ["AGUIClient", "AGUICore"]),
    ]
)
