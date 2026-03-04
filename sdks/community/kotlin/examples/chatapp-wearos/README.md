# ChatApp Wear OS Sample

A standalone Wear OS sample that reuses the `chatapp-shared` Kotlin multiplatform core to deliver an AG-UI chat experience on a watch. The app demonstrates how to consume the shared networking, state, and tool-confirmation layers while rendering a Wear-optimized interface with `androidx.wear.compose:compose-material3`.

## Highlights
- Connects to AG-UI agents through the `ChatController` exposed by `chatapp-shared`
- Shows streaming responses, tool confirmations, and error recovery in a compact wearable layout
- Lets you add, edit, and activate agents directly on the watch via the built-in agent manager
- Ships as a standalone Wear OS application (no phone companion required)

## Project Layout
```
chatapp-wearos/
  ├─ wearApp/              # Wear OS application module
  │   ├─ src/main/java/com/agui/example/chatwear/ui
  │   └─ src/main/res
  ├─ build.gradle.kts      # Shared plugin declarations
  └─ settings.gradle.kts   # Includes chatapp-shared for reuse
```

## Configuring a Default Agent
The app can seed an initial agent using Gradle properties. Add the following entries to your `~/.gradle/gradle.properties` (or `local.properties`) file:

```
chatapp.wear.defaultAgentUrl=https://your-agent-host/v1
chatapp.wear.defaultAgentName=Wear Demo Agent
chatapp.wear.defaultAgentDescription=Sample configuration for the Wear OS demo
chatapp.wear.defaultAgentApiKey=sk-your-api-key
chatapp.wear.defaultAgentApiKeyHeader=X-API-Key
chatapp.wear.quickPrompts=Hello|What can you do?|Summarize today’s updates
```

Leave the API key fields blank if your agent does not require authentication. When no defaults are provided, open **Manage agents** on the watch to configure one manually.

## Building & Running

From the repository root:

```bash
./gradlew :sdks:community:kotlin:examples:chatapp-wearos:wearApp:assembleDebug
```

Use Android Studio Hedgehog (or newer) with a Wear OS emulator or device running API 30+ to install the generated APK.

## Next Steps
- Point the sample at your own AG-UI agent and experiment with quick prompts
- Extend the UI with Tiles, Complications, or voice input to compose messages hands-free
