# ChatApp Shared Core

A Kotlin Multiplatform module that exposes the non-UI logic reused by the chat application samples.

## Responsibilities

- Agent persistence via the multiplatform `AgentRepository`
- Authentication providers (API Key, Bearer, Basic, OAuth2/custom hook point)
- Chat orchestration through the UI-agnostic `ChatController`, which now wires the Kotlin client `AgentSubscriber` hooks to
  populate conversation history and ephemerals across platforms
- Platform utilities (settings storage, user ID management, string helpers)
- Tool confirmation integration shared across platforms

The Compose Multiplatform, SwiftUI, and Android Views (chatapp-java) samples all depend on this module for networking, persistence, and business rules.

## Targets

The module ships with Android, JVM desktop, and iOS targets. Consumers compile it directly (Compose) or bundle it inside an XCFramework (SwiftUI).

## Building

From the `chatapp-swiftui` or `chatapp` project roots you can reference the Gradle project as `:chatapp-shared`.

```bash
./gradlew :chatapp-shared:assemble
```

The SwiftUI sample's `:shared` module packages this core component into `shared.xcframework` for Xcode.
