# AG-UI Android (Views) Sample

Android View-based chat client that consumes the shared Kotlin Multiplatform core (`chatapp-shared`) while keeping the UI in the traditional XML/ViewBinding stack. The screens remain Java-friendly, but the business logic, agent storage, and streaming behaviour now come directly from the shared Kotlin module used by the Compose and SwiftUI samples.

## Highlights

- ♻️ **Shared Core** – Reuses the `chatapp-shared` module for repositories, auth, chat orchestration, tool confirmation, and storage.
- 🧱 **Views + ViewModel** – UI stays on XML/ViewBinding with `ChatActivity` in Java calling into a Kotlin `ChatViewModel`/`ChatController` bridge.
- 🧑‍🤝‍🧑 **Multi-agent settings** – Same agent CRUD experience as other samples, backed by `AgentRepository` and exposed through a new Kotlin `MultiAgentRepository` wrapper.
- ⚙️ **Zero RxJava** – Pure coroutines/LiveData interop; no bespoke Java adapters around the AG‑UI flows.
- 🧩 **Kotlin + Java interop** – Kotlin files provide the glue (ViewModel, repository, list adapter), while the chat screen remains Java to demonstrate interop ergonomics.

## Project Layout

```
chatapp-java/
├── app/
│   ├── src/main/java/com/agui/chatapp/java/
│   │   ├── ChatJavaApplication.kt     // Initialises shared platform settings
│   │   ├── repository/                // Kotlin wrapper around chatapp-shared AgentRepository
│   │   ├── viewmodel/                 // Kotlin ChatViewModel exposing LiveData to Java UI
│   │   ├── ui/                        // ChatActivity (Java) + SettingsActivity (Kotlin)
│   │   │   └── adapter/               // MessageAdapter (Java) + AgentListAdapter (Kotlin)
│   │   └── model/ChatMessage.kt       // UI-friendly view state built from DisplayMessage
│   └── src/main/res/...               // Unchanged Material 3 XML layouts
├── settings.gradle                    // Includes :chatapp-shared via composite build
└── build.gradle                       // Adds Kotlin plugin + AGP 8.12
```

## How the pieces fit

```
      Java UI (ChatActivity) ─────────┐
         ↑                            │ LiveData
         │ uses ViewModelProvider     │
         │                            ▼
Kotlin ChatViewModel (AndroidViewModel) ── ChatController (chatapp-shared)
         │                            │
         │ coroutines/flows           │
         ▼                            ▼
Kotlin MultiAgentRepository ─── AgentRepository (chatapp-shared)
```

- `ChatController` handles streaming, tool confirmation, auth, and message state.
- `AgentRepository` (shared) owns persistent agents; `MultiAgentRepository` wraps it with LiveData/CompletableFuture for the Java UI.
- `ChatMessage.kt` converts `DisplayMessage` objects into a RecyclerView-friendly model.

## Prerequisites

- Android SDK / command-line tools installed (`sdk.dir` in `local.properties` or `ANDROID_HOME` env var).
- JDK 21.
- Kotlin Gradle plugin 2.2.20 (pulled automatically via plugin management).

## Building

```bash
# From chatapp-java/
./gradlew :chatapp-shared:assemble     # optional: prebuild shared core
./gradlew :app:assembleDebug          # build the Android sample
```

> ℹ️ The shared core expects an Android context. `ChatJavaApplication` calls `initializeAndroid(this)` on startup.

## Updating agents from the UI

- Open Settings ➜ add/edit/delete agents (auth types: None, API Key, Bearer, Basic).
- Activating an agent calls `AgentRepository.setActiveAgent`, which immediately reconnects the `ChatController`.
- System prompts and auth headers are stored via multiplatform `Settings` (shared Preferences on Android).

## What changed vs. the original Java sample

| Area                | Before                               | Now |
|--------------------|--------------------------------------|-----|
| Business logic     | Hand-rolled Java repository & adapter| Shared `chatapp-shared` module |
| Streaming bridge   | RxJava wrapper over Flow             | Direct `ChatController` + LiveData |
| Auth models        | Custom Java `AuthMethod`             | Shared KMP `AuthMethod` | 
| Agent storage      | SharedPreferences manual schema      | Shared multiplatform `AgentRepository` |
| UI stack           | Java Activities                      | Chat screen still Java; settings + adapters moved to Kotlin for convenience |

The sample now mirrors the Compose/SwiftUI architecture while keeping a classical Android view layer for teams that are not ready for Compose.
