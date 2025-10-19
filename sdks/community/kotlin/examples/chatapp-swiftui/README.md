# AG-UI Kotlin SDK SwiftUI Sample Client

This sample demonstrates how to combine the core **AG-UI Kotlin libraries** with a **SwiftUI** interface that follows native iOS architecture guidelines. The multiplatform business logic now lives in the separate `../chatapp-shared` module, while this project adds a lightweight Kotlin bridge that exposes the shared flows to Swift.

## Features

- 📱 Native SwiftUI experience for iPhone and iPad
- 🤖 Real-time streaming chat backed by the Kotlin AG-UI client
- 🧑‍🤝‍🧑 Multi-agent management with persistent storage
- 🔐 Flexible authentication (None, API Key, Bearer, Basic, OAuth2, Custom)
- 🧰 Tool execution with inline confirmation prompts
- 🧵 Threaded conversations with ephemeral state indicators

## Project Structure

```
chatapp-swiftui/
├── iosApp/                 # SwiftUI sources and XcodeGen project definition
├── shared/                 # Kotlin bridge that wraps chatapp-shared for Swift consumption
├── build.gradle.kts
├── settings.gradle.kts
├── gradlew / gradlew.bat
└── README.md
```
The Gradle build reuses `../chatapp-shared` via an included project reference. Kotlin UI code is implemented natively in Swift.

## Prerequisites

- macOS with Xcode 15+
- Android Studio or IntelliJ IDEA (for Kotlin development)
- Kotlin 2.0+ toolchain (installed by Gradle wrapper)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) for generating the Xcode project

## Getting Started

1. **Build the Kotlin framework**

   ```bash
   ./gradlew :shared:assembleXCFramework
   ```

   The task outputs `shared.xcframework` to `shared/build/XCFrameworks/release/` which the SwiftUI project consumes.

2. **Generate the Xcode project**

   ```bash
   cd iosApp
   xcodegen generate
   ```

3. **Open the project**

   Open `ChatAppSwiftUI.xcodeproj` in Xcode, select a simulator or device, and run the app.

### Swift Package configuration

The generated project includes a local Swift package that wraps the Kotlin framework. Re-run the Gradle build whenever Kotlin sources change to refresh the binary.

## SwiftUI Architecture

The Swift layer follows a unidirectional data flow:

- `ChatAppStore` bridges Kotlin Flows to Combine-friendly `@Published` properties using the `ChatViewModelBridge` and `AgentRepositoryBridge` helpers exposed from the `shared` bridge module.
- SwiftUI views (`ChatView`, `AgentListView`, `AgentFormView`) subscribe to the store and dispatch user intents back to Kotlin for processing.
- Kotlin remains responsible for persistence, AG-UI protocol streaming, authentication, and tool coordination through the shared `ChatController`, leaving presentation to SwiftUI.

## Testing & Verification

- Kotlin unit tests remain available via the shared module: `./gradlew :shared:check`
- SwiftUI preview snapshots can be built within Xcode once the framework has been generated.

## Troubleshooting

- If the Swift compiler cannot locate `shared.xcframework`, ensure the Gradle build completed successfully and that Xcode is pointed at the release output directory.
- Authentication secrets are stored using the same secure storage backing as the Kotlin sample via `NSUserDefaults`.
- Tool confirmation dialogs appear as SwiftUI alerts, mirroring the Compose UX.

## License

This sample inherits the AG-UI repository license.
