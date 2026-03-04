# AG-UI Kotlin SDK

A Kotlin Multiplatform implementation of the AG-UI (Agent User Interaction) Protocol, supporting JVM, Android, and iOS platforms.

## Features

- 🎯 **Kotlin Multiplatform** - Write once, run on JVM, Android, and iOS
- 🔄 **Full Protocol Support** - Complete implementation of the AG-UI protocol
- 📦 **Modular Architecture** - Three focused modules: core, client, and tools
- 🌐 **Multiple Transports** - HTTP, SSE (Server-Sent Events), and extensible transport layer
- 📱 **Native iOS Support** - Published as .klib artifacts to Maven Central
- 🔧 **Tool Execution Framework** - Built-in circuit breaker and retry logic

## Modules

- **kotlin-core** - Protocol types, events, and message definitions
- **kotlin-client** - HTTP transport, SSE parsing, state management, and high-level agent APIs
- **kotlin-tools** - Tool execution framework with registry and orchestration

## Installation

### Maven Central Coordinates

The SDK is published to Maven Central under the group `com.ag-ui.community`.

Latest version: **Check [Maven Central](https://central.sonatype.com/artifact/com.ag-ui.community/kotlin-core) for the current version**

### JVM / Android Projects

Add Maven Central to your repositories and include the dependencies:

```kotlin
// build.gradle.kts
repositories {
    mavenCentral()
}

dependencies {
    val agUiVersion = "0.2.3" // Check Maven Central for latest version

    implementation("com.ag-ui.community:kotlin-core:$agUiVersion")
    implementation("com.ag-ui.community:kotlin-client:$agUiVersion")
    implementation("com.ag-ui.community:kotlin-tools:$agUiVersion")
}
```

## Quick Start

### Basic Agent Usage

```kotlin
import com.agui.client.HttpAgent
import com.agui.core.RunAgentInput
import kotlinx.coroutines.flow.collect

// Create an HTTP agent
val agent = HttpAgent(baseUrl = "https://your-agent-api.com")

// Run the agent and collect events
agent.run(RunAgentInput(prompt = "Hello, agent!")).collect { event ->
    when (event) {
        is TextMessageDeltaEvent -> println(event.delta.text)
        is RunFinishedEvent -> println("Run completed")
        // Handle other event types...
    }
}
```

### Stateful Agent (Maintains Conversation History)

```kotlin
import com.agui.client.StatefulAgUiAgent

val statefulAgent = StatefulAgUiAgent(baseUrl = "https://your-agent-api.com")

// First request
statefulAgent.run("Tell me about Kotlin")

// Follow-up request (maintains context)
statefulAgent.run("What about multiplatform support?")

// Access conversation history
val messages = statefulAgent.getMessages()
```

## iOS Projects (Kotlin Multiplatform)

iOS artifacts are published as `.klib` files to Maven Central and can be consumed directly in Kotlin Multiplatform projects.

#### Setup in Kotlin Multiplatform Project

```kotlin
// In your shared module's build.gradle.kts
kotlin {
    // Configure iOS targets
    iosX64()
    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        val commonMain by getting {
            dependencies {
                val agUiVersion = "0.2.3" // Check Maven Central for latest version

                implementation("com.ag-ui.community:kotlin-core:$agUiVersion")
                implementation("com.ag-ui.community:kotlin-client:$agUiVersion")
                implementation("com.ag-ui.community:kotlin-tools:$agUiVersion")
            }
        }
    }
}
```

The Kotlin Multiplatform plugin will automatically resolve the correct iOS variant:
- `kotlin-core-iosx64` - for macOS/iOS Simulator on Intel Macs
- `kotlin-core-iosarm64` - for physical iOS devices
- `kotlin-core-iossimulatorarm64` - for iOS Simulator on Apple Silicon Macs

#### Using with Xcode

1. **Build the shared framework** in your Kotlin Multiplatform project:
   ```bash
   ./gradlew :shared:linkDebugFrameworkIosArm64
   # or for simulator:
   ./gradlew :shared:linkDebugFrameworkIosSimulatorArm64
   ```

2. **Link the framework** to your Xcode project as you would with any KMP framework

3. **Import and use** in Swift:
   ```swift
   import Shared

   // Use AG-UI types
   let agent = HttpAgent(/* ... */)
   ```

#### Important Notes for iOS Developers

- ✅ **iOS artifacts ARE published to Maven Central** (since version 0.2.3)
- 📦 iOS artifacts use Kotlin's native `.klib` format
- 🔧 They must be consumed through a Kotlin Multiplatform shared module
- ⚠️ They cannot be used directly in pure Swift/Objective-C projects without the KMP framework layer
- 🎯 The KMP plugin handles variant resolution automatically based on your build target

#### Alternative: Local Maven Installation

If you need to test locally or work with unreleased versions:

```bash
cd library
./gradlew publishToMavenLocal
```

Then add `mavenLocal()` to your repositories:

```kotlin
repositories {
    mavenLocal()
    mavenCentral()
}
```

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| **JVM** | ✅ Full Support | Java 21+ |
| **Android** | ✅ Full Support | API 26+ (Android 8.0) |
| **iOS** | ✅ Full Support | arm64, x64, simulator arm64 |

## Dependencies

- **Kotlin** 2.2.20 with K2 compiler
- **Ktor** 3.1.3 for HTTP client
- **Kotlinx Serialization** 1.8.1
- **Kotlinx Coroutines** 1.10.2
- **Kotlinx Datetime** 0.6.2
- **Kermit** 2.0.6 for multiplatform logging

## Development

### Building from Source

```bash
# Build all modules
./gradlew build

# Run tests
./gradlew allTests

# Run tests for specific module
./gradlew :kotlin-core:jvmTest
./gradlew :kotlin-client:jvmTest
./gradlew :kotlin-tools:jvmTest

# Run tests for specific platform
./gradlew jvmTest                    # JVM platform tests
./gradlew iosSimulatorArm64Test      # iOS simulator tests
./gradlew connectedDebugAndroidTest  # Android device tests

# Publish to local Maven
./gradlew publishToMavenLocal

# Generate documentation
./gradlew dokkaHtmlMultiModule
# View at: build/dokka/htmlMultiModule/index.html

# Generate coverage reports
./gradlew koverHtmlReportAll
```

### Project Structure

```
library/
├── core/               # Core protocol types and events
├── client/             # HTTP client and state management
├── tools/              # Tool execution framework
├── build.gradle.kts    # Root build configuration
└── settings.gradle.kts # Module configuration
```

## Documentation

- 📚 [API Documentation](../../docs/) - Generated KDoc documentation
- 💡 [Examples](../examples/) - Sample applications for all platforms
- 🌐 [AG-UI Protocol Specification](https://github.com/ag-ui-protocol/ag-ui)
- 🔧 [Development Guide](../CLAUDE.md) - Build commands and architecture

## License

MIT License - See [LICENSE](../../../../LICENSE) for details

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](../../../../CONTRIBUTING.md) for guidelines.

## Support

- 🐛 [Report Issues](https://github.com/ag-ui-protocol/ag-ui/issues)
- 💬 [Discussions](https://github.com/ag-ui-protocol/ag-ui/discussions)
- 📧 Community: [AG-UI Protocol](https://github.com/ag-ui-protocol/ag-ui)

## Acknowledgments

Built with ❤️ by the AG-UI community. Part of the [AG-UI Protocol](https://github.com/ag-ui-protocol/ag-ui) project.
