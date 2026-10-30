# AG-UI Swift SDK

This community Swift package contains `AGUICore` for AG-UI event and message
types and `AGUIClient` for HTTP streaming agents. It also includes the
`agui-dojo-chat` example command. The package declares iOS 16+ and macOS 13+
in [Package.swift](Package.swift), and requires Swift 5.9 or newer.

## Use in a local Swift package

The SDK currently lives in the [AG-UI monorepo](../../..). Add a local package
dependency pointing to `sdks/community/swift`. For example, if the consuming
`Package.swift` is at the monorepo root, use:

```swift
dependencies: [
    .package(path: "sdks/community/swift"),
],
targets: [
    .target(
        name: "YourApp",
        dependencies: [
            .product(name: "AGUICore", package: "AGUISwift"),
            .product(name: "AGUIClient", package: "AGUISwift"),
        ]
    ),
]
```

Import `AGUICore` for protocol models and `AGUIClient` for `HttpAgent`.
Adjust the path for the location of your own package manifest.
The package is not yet distributed through a standalone SwiftPM repository;
a standalone package URL is deferred.

## Build and test

From this directory:

```bash
swift build
swift test
```

The example command connects to a local dojo at `http://127.0.0.1:18000` by
default. Set `AGUI_DOJO_BASE_URL` to use another base URL:

```bash
swift run agui-dojo-chat "Hello"
```

See the [Swift SDK overview](../../../docs/sdk/swift/overview.mdx) for more
context, [CHANGELOG.md](CHANGELOG.md) for changes, and
[DERIVATION.md](DERIVATION.md) for source attribution. This package retains the
original [MIT license](LICENSE).
