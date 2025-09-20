# AG-UI Kotlin SDK Java Chat App

A Java-based Android chat application demonstrating how to use the Kotlin Multiplatform AG-UI libraries from pure Java code using Android View system and Material 3 design.

## Features

- 🏗️ **Pure Java Implementation**: Demonstrates Kotlin/Java interop with KMP libraries
- 🎨 **Material 3 Design**: Uses Material Design Components for Android (not Compose)
- 📱 **Android View System**: Traditional Android View-based UI instead of Compose
- 🔄 **RxJava Integration**: Converts Kotlin Flow to RxJava Observable for Java consumption
- 🔐 **Authentication Support**: Bearer Token, API Key, and no-auth options
- 💬 **Real-time Streaming**: Character-by-character streaming responses
- ⚙️ **Settings Screen**: Configure agent URL, authentication, and system prompts
- 📱 **MVVM Architecture**: Uses Android Architecture Components (ViewModel, LiveData)

## Architecture

This example demonstrates how to use the AG-UI Kotlin SDK from Java without any modifications to the KMP libraries:

```
Java Application Layer
├── UI (Activities, Fragments)
├── ViewModels (Java + Architecture Components)
├── Repository (SharedPreferences)
└── Java Adapter Layer
    ├── AgUiJavaAdapter (Flow → RxJava conversion)
    ├── AgUiAgentBuilder (Java-friendly builder)
    └── EventProcessor (Type-safe event handling)

Kotlin Multiplatform Libraries (Unchanged)
├── kotlin-client (AgUiAgent, StatefulAgUiAgent)
├── kotlin-core (Message types, Events)
└── kotlin-tools (Tool execution framework)
```

## Key Integration Components

### 1. Java Adapter Layer
- **AgUiJavaAdapter**: Converts Kotlin Flow to RxJava Observable
- **AgUiAgentBuilder**: Provides Java builder pattern for agent configuration
- **EventProcessor**: Type-safe event handling for sealed classes

### 2. Interop Libraries Used
- `kotlinx-coroutines-reactive`: Converts Flow to RxJava
- `kotlinx-coroutines-jdk8`: CompletableFuture integration
- `rxjava3`: Reactive streams for Java

### 3. Material 3 Components
- MaterialToolbar
- MaterialCardView for message bubbles
- TextInputLayout with Material styling
- MaterialButton and MaterialSwitch
- LinearProgressIndicator
- Snackbar for notifications

## Building and Running

### Prerequisites
- Android Studio Arctic Fox or later
- JDK 21
- Android SDK 35 (API level 35)
- AG-UI Kotlin SDK libraries published to Maven Local

### Build Steps

1. **Publish KMP libraries locally** (from `/library` directory):
   ```bash
   ./gradlew publishToMavenLocal
   ```

2. **Open the project** in Android Studio:
   ```bash
   # From this directory
   open . 
   # Or import the project in Android Studio
   ```

3. **Build and run**:
   ```bash
   ./gradlew :app:assembleDebug
   ./gradlew :app:installDebug
   ```

## Usage

1. **Launch the app** - you'll see a prompt to configure an agent
2. **Tap "Settings"** to configure your agent:
   - Enter your agent URL
   - Select authentication type (None, Bearer Token, or API Key)
   - Enter authentication credentials if needed
   - Optionally set a system prompt
   - Test the connection
   - Save settings
3. **Return to chat** and start messaging with your agent
4. **View real-time responses** with character-by-character streaming

## Code Structure

```
app/src/main/java/com/agui/chatapp/java/
├── adapter/                  # Kotlin-Java interop layer
│   ├── AgUiJavaAdapter.java     # Flow → RxJava converter
│   ├── AgUiAgentBuilder.java    # Java-friendly builder
│   ├── EventCallback.java       # Callback interface
│   └── EventProcessor.java      # Event type dispatcher
├── model/
│   └── ChatMessage.java         # UI model wrapping Message
├── repository/
│   └── AgentRepository.java     # SharedPreferences storage
├── ui/
│   ├── ChatActivity.java        # Main chat screen
│   ├── SettingsActivity.java    # Agent configuration
│   └── adapter/
│       └── MessageAdapter.java  # RecyclerView adapter
└── viewmodel/
    └── ChatViewModel.java        # MVVM ViewModel
```

## Key Integration Techniques

### 1. Flow to RxJava Conversion
```java
// Convert Kotlin Flow to RxJava Observable
Flow<BaseEvent> kotlinFlow = agent.chat(message);
Observable<BaseEvent> javaObservable = 
    Observable.fromPublisher(ReactiveFlowKt.asPublisher(kotlinFlow));
```

### 2. Builder Pattern for Configuration
```java
// Java-friendly builder instead of Kotlin DSL
AgUiAgent agent = AgUiAgentBuilder.create(url)
    .bearerToken("token")
    .systemPrompt("You are helpful")
    .debug(true)
    .buildStateful();
```

### 3. Type-Safe Event Handling
```java
// Handle Kotlin sealed classes in Java
EventProcessor.processEvent(event, new EventProcessor.EventHandler() {
    @Override
    public void onTextMessageContent(TextMessageContentEvent event) {
        updateMessage(event.getMessageId(), event.getDelta());
    }
    // ... other event handlers
});
```

## Dependencies

The app demonstrates pure Java consumption of KMP libraries:

- **KMP Libraries**: `kotlin-client`, `kotlin-core`, `kotlin-tools`
- **Interop**: `kotlinx-coroutines-reactive`, `kotlinx-coroutines-jdk8`
- **Java Reactive**: `rxjava3`, `rxandroid`
- **Android**: Architecture Components, Material 3
- **Storage**: SharedPreferences for persistence

## Benefits

- **No KMP Library Changes**: Uses libraries as-is without modifications
- **Java Team Friendly**: Standard Java patterns and Android Views
- **Material 3**: Modern design with traditional View system
- **Full Feature Parity**: Supports all KMP library features
- **Type Safety**: Maintains type safety across language boundaries

This example proves that teams can adopt AG-UI Kotlin SDK incrementally, starting with Java and migrating to Kotlin/Compose when ready, without requiring changes to the core libraries.