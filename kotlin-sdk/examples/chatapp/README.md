# AG-UI Kotlin SDK Compose Multiplatform Client

A Compose Multiplatform chat client for connecting to AI agents using the AG-UI protocol.

## Features

- 🎨 **Modern UI**: Clean, minimalist chat interface with Material 3 design
- 🔐 **Flexible Authentication**: Support for API Key, Bearer Token, Basic Auth, and custom methods
- 🌍 **Cross-Platform**: Runs on Android, iOS, and Desktop (JVM)
- 🤖 **Multi-Agent Support**: Add and manage multiple AI agents
- 💬 **Real-time Streaming**: See AI responses character-by-character
- ⚙️ **Settings Management**: Persistent storage of agent configurations

## Architecture

The client follows a clean architecture pattern:

- **UI Layer**: Compose Multiplatform UI with Material 3
- **ViewModel Layer**: Screen-specific business logic using Voyager
- **Repository Layer**: Data management and persistence
- **Authentication Layer**: Extensible auth provider system

## Getting Started

### Prerequisites

- JDK 21 or higher (required for building)
- Android Studio or IntelliJ IDEA with Compose Multiplatform plugin
- Xcode 14+ (for iOS development)
- Kotlin 2.2.0 or higher

### Running the Client

#### Android
```bash
./gradlew :androidApp:installDebug
```

#### Desktop (JVM)
```bash
./gradlew :desktopApp:run
```

#### iOS
1. Open `chatapp/iosApp/iosApp.xcodeproj` in Xcode
2. Select your target device or simulator
3. Build and run (⌘+R)

**Note**: The iOS app requires the Kotlin framework to be built first. This happens automatically when building through Xcode.

## Usage

### Adding an Agent

1. Launch the app
2. Tap the Settings icon in the top right
3. Tap the + button to add a new agent
4. Enter the agent details:
   - **Name**: A friendly name for the agent
   - **URL**: The AG-UI endpoint (e.g., `https://api.example.com/agent`)
   - **Description**: Optional description
   - **Authentication**: Select and configure the auth method

### Authentication Methods

#### No Authentication
For public agents that don't require authentication.

#### API Key
- Enter your API key
- Optionally customize the header name (default: `X-API-Key`)

#### Bearer Token
- Enter your bearer token
- Automatically adds `Authorization: Bearer <token>` header

#### Basic Auth
- Enter username and password
- Automatically encodes and adds `Authorization: Basic <encoded>` header

### Chatting with an Agent

1. Select an agent from the settings screen
2. Return to the chat screen
3. Type your message and tap send
4. Watch the AI response stream in real-time

## Extending Authentication

To add a custom authentication method:

1. Create a new `AuthMethod` subclass:
```kotlin
@Serializable
data class CustomAuth(
    val customField: String
) : AuthMethod()
```

2. Implement an `AuthProvider`:
```kotlin
class CustomAuthProvider : AuthProvider {
    override fun canHandle(authMethod: AuthMethod): Boolean {
        return authMethod is CustomAuth
    }
    
    override suspend fun applyAuth(
        authMethod: AuthMethod, 
        headers: MutableMap<String, String>
    ) {
        // Add your custom headers
    }
}
```

3. Register the provider in `AuthManager`:
```kotlin
authManager.registerProvider(CustomAuthProvider())
```

## Customization

### Theming
The app uses Material 3 theming. Customize colors in:
- `shared/src/commonMain/kotlin/com/agui/example/chatapp/ui/theme/Color.kt`
- `shared/src/commonMain/kotlin/com/agui/example/chatapp/ui/theme/Theme.kt`

### Storage
Agent configurations are stored using platform-specific preferences:
- **Android**: SharedPreferences
- **iOS**: NSUserDefaults
- **Desktop**: Java Preferences

## Building for Production

### Android
```bash
./gradlew :androidApp:assembleRelease
```

### Desktop
```bash
./gradlew :desktopApp:packageDistributionForCurrentOS
```

### iOS
1. Set up your development team in Xcode project settings
2. Configure code signing and provisioning profiles
3. Archive and distribute through Xcode (Product → Archive)

## Troubleshooting

### Connection Issues
- Verify the agent URL is correct and accessible
- Check authentication credentials
- Ensure the agent implements the AG-UI protocol

### Performance
- The app uses Kotlin coroutines for efficient async operations
- Message streaming is optimized to update UI smoothly
- Large conversation histories are handled efficiently with lazy loading

## Dependencies

- **agui-kotlin-sdk**: The core AG-UI protocol implementation
- **Compose Multiplatform**: UI framework
- **Voyager**: Navigation and ViewModels
- **Ktor**: HTTP client (inherited from agui-kotlin-sdk)
- **kotlinx.serialization**: JSON handling
- **Multiplatform Settings**: Cross-platform preferences storage

## License

MIT License - See the parent project's LICENSE file