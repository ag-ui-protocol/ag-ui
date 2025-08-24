# AG-UI Kotlin SDK Overview

## Table of Contents

1. [Introduction](#introduction)
2. [Architecture Overview](#architecture-overview)
3. [API Reference](#api-reference)
   - [Core Module](#core-module)
   - [Client Module](#client-module)
   - [Tools Module](#tools-module)
   - [Agent SDK Module](#agent-sdk-module)

## Introduction

AG-UI Kotlin SDK is a Kotlin Multiplatform client library for connecting to AI agents that implement the [Agent User Interaction Protocol (AG-UI)](https://docs.ag-ui.com/). The library provides transport mechanisms, state management, and tool integration for communication between Kotlin applications and AI agents across Android, iOS, and JVM platforms.

This documentation covers:
- **Core implementation**: Protocol types, events, and messages
- **Client infrastructure**: Transport mechanisms and state management
- **Tool integration**: Extensible tool execution framework
- **High-level SDK**: Orchestration layers for agent interaction

## Architecture Overview

AG-UI Kotlin SDK follows the design patterns of the [TypeScript SDK](https://docs.ag-ui.com/sdk/js/core/overview) while using Kotlin's multiplatform capabilities and coroutine-based concurrency.

### Module Structure

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                          │
├─────────────────────────────────────────────────────────────┤
│                   kotlin-client                              │
│  ┌─────────────┐  ┌───────────────────┐  ┌──────────────┐  │
│  │ AgUiAgent   │  │StatefulAgUiAgent  │  │   Builders   │  │
│  └─────────────┘  └───────────────────┘  └──────────────┘  │
├─────────────────────────────────────────────────────────────┤
│        kotlin-client              │      kotlin-tools        │
│  ┌────────────┐  ┌─────────────┐ │ ┌──────────────────────┐ │
│  │ HttpAgent  │  │AbstractAgent│ │ │    ToolExecutor      │ │
│  └────────────┘  └─────────────┘ │ └──────────────────────┘ │
│  ┌────────────┐  ┌─────────────┐ │ ┌──────────────────────┐ │
│  │EventVerifier│ │DefaultApply │ │ │    ToolRegistry      │ │
│  │            │  │   Events    │ │ └──────────────────────┘ │
│  └────────────┘  └─────────────┘ │ ┌──────────────────────┐ │
│  ┌────────────┐                   │ │ ToolExecutionManager │ │
│  │ SseParser  │                   │ └──────────────────────┘ │
│  └────────────┘                   │                          │
├─────────────────────────────────────────────────────────────┤
│                    kotlin-core                               │
│        (Types, Events, Messages, State)                      │
└─────────────────────────────────────────────────────────────┘
```

### Alignment with TypeScript SDK

AG-UI Kotlin SDK maintains conceptual parity with the TypeScript SDK:

| TypeScript Concept | Kotlin Implementation | Key Differences |
|-------------------|----------------------|-----------------|
| Observable streams | Kotlin Flows | Native coroutine integration |
| Promise-based APIs | Suspend functions | Structured concurrency |
| Event interfaces | Sealed classes | Compile-time exhaustiveness |
| JSON handling | kotlinx.serialization | Type-safe, reflection-free |
| Transport abstraction | HttpAgent | Platform-specific implementations |

## API Reference

### Core Module

The core module defines the types and protocols for AG-UI communication.

#### Messages

Messages represent the conversational elements between users and agents:

```kotlin
sealed class Message {
    abstract val id: String
    abstract val messageRole: Role
    abstract val content: String?
    abstract val name: String?
}

// Message implementations
data class UserMessage(
    override val id: String,
    override val content: String,
    override val name: String? = null
) : Message()

data class AssistantMessage(
    override val id: String,
    override val content: String? = null,
    override val name: String? = null,
    val toolCalls: List<ToolCall>? = null
) : Message()

data class ToolMessage(
    override val id: String,
    override val content: String,
    val toolCallId: String,
    override val name: String? = null
) : Message()
```

#### Events

Events represent protocol-level communications:

```kotlin
sealed class BaseEvent {
    abstract val eventType: EventType
    abstract val timestamp: Long?
    abstract val rawEvent: JsonElement?
}

// Lifecycle events
data class RunStartedEvent(
    val threadId: String,
    val runId: String,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent()

// Text streaming events
data class TextMessageContentEvent(
    val messageId: String,
    val delta: String,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent()

// Tool execution events
data class ToolCallStartEvent(
    val toolCallId: String,
    val toolCallName: String,
    val parentMessageId: String? = null,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent()
```

#### State Management

State represents the agent's context:

```kotlin
typealias State = JsonElement

data class RunAgentInput(
    val threadId: String,
    val runId: String,
    val state: JsonElement = JsonObject(emptyMap()),
    val messages: List<Message> = emptyList(),
    val tools: List<Tool> = emptyList(),
    val context: List<Context> = emptyList(),
    val forwardedProps: JsonElement = JsonObject(emptyMap())
)
```

### Client Module

The client module provides infrastructure for connecting to AG-UI agents.

#### AbstractAgent

Base class for agent implementations:

```kotlin
abstract class AbstractAgent(config: AgentConfig = AgentConfig()) {
    var agentId: String? = config.agentId
    val description: String = config.description
    val threadId: String = config.threadId ?: generateId()
    
    var messages: List<Message> = config.initialMessages
        protected set
    
    var state: State = config.initialState
        protected set
    
    // Core execution methods
    suspend fun runAgent(parameters: RunAgentParameters? = null)
    fun runAgentObservable(input: RunAgentInput): Flow<BaseEvent>
    
    // Lifecycle management
    open fun abortRun()
    open fun dispose()
    
    // Extension points
    protected abstract fun run(input: RunAgentInput): Flow<BaseEvent>
    protected open fun apply(input: RunAgentInput, events: Flow<BaseEvent>): Flow<AgentState>
    protected open fun onError(error: Throwable)
    protected open fun onFinalize()
}
```

#### HttpAgent

HTTP transport implementation with Server-Sent Events:

```kotlin
class HttpAgent(
    private val config: HttpAgentConfig,
    private val httpClient: HttpClient? = null
) : AbstractAgent(config) {
    
    override fun run(input: RunAgentInput): Flow<BaseEvent> = channelFlow {
        client.sse(
            urlString = config.url,
            request = {
                method = HttpMethod.Post
                config.headers.forEach { (key, value) ->
                    header(key, value)
                }
                contentType(ContentType.Application.Json)
                accept(ContentType.Text.EventStream)
                setBody(input)
            }
        ) {
            sseParser.parseFlow(incoming)
                .collect { event -> send(event) }
        }
    }
}
```

#### State Synchronization

The `defaultApplyEvents` function manages state updates with JSON Patch support:

```kotlin
fun defaultApplyEvents(
    input: RunAgentInput,
    events: Flow<BaseEvent>,
    stateHandler: StateChangeHandler? = null
): Flow<AgentState> {
    // Manages message accumulation
    // Applies state snapshots and deltas
    // Handles predictive state updates
    // Coordinates tool call assembly
}
```

### Tools Module

The tools module provides a framework for extending agent capabilities.

#### Tool Definition and Execution

```kotlin
interface ToolExecutor {
    val tool: Tool
    suspend fun execute(context: ToolExecutionContext): ToolExecutionResult
    fun validate(toolCall: ToolCall): ToolValidationResult
    fun canExecute(toolCall: ToolCall): Boolean
    fun getMaxExecutionTimeMs(): Long? = null
}

abstract class AbstractToolExecutor(
    override val tool: Tool
) : ToolExecutor {
    override suspend fun execute(context: ToolExecutionContext): ToolExecutionResult {
        val validation = validate(context.toolCall)
        if (!validation.isValid) {
            return ToolExecutionResult.failure(
                message = "Validation failed: ${validation.errors.joinToString(", ")}"
            )
        }
        return executeInternal(context)
    }
    
    protected abstract suspend fun executeInternal(
        context: ToolExecutionContext
    ): ToolExecutionResult
}
```

#### Tool Registry

Manages tool discovery and execution:

```kotlin
interface ToolRegistry {
    fun registerTool(executor: ToolExecutor)
    fun unregisterTool(toolName: String): Boolean
    fun getToolExecutor(toolName: String): ToolExecutor?
    fun getAllTools(): List<Tool>
    suspend fun executeTool(context: ToolExecutionContext): ToolExecutionResult
    fun getToolStats(toolName: String): ToolExecutionStats?
}

// Builder pattern for configuration
fun toolRegistry(vararg executors: ToolExecutor): ToolRegistry {
    return ToolRegistryBuilder().addTools(*executors).build()
}
```

#### Tool Execution Manager

Orchestrates tool execution lifecycle:

```kotlin
class ToolExecutionManager(
    private val toolRegistry: ToolRegistry,
    private val responseHandler: ToolResponseHandler
) {
    fun processEventStream(
        events: Flow<BaseEvent>,
        threadId: String?,
        runId: String?
    ): Flow<BaseEvent> = flow {
        // Monitors tool call events
        // Assembles streaming arguments
        // Executes tools via registry
        // Sends responses back to agent
    }
}
```

### Agent SDK Module

The SDK module provides high-level abstractions for agent patterns.

#### AgUiAgent (Stateless)

For agents that manage their own state:

```kotlin
class AgUiAgent(
    url: String,
    configure: AgentConfig.() -> Unit = {}
) {
    suspend fun sendMessage(
        content: String,
        tools: List<Tool> = emptyList()
    ): Flow<State> {
        // Creates user message
        // Runs agent with message
        // Returns state updates
    }
    
    fun runWithInput(input: RunAgentInput): Flow<BaseEvent> {
        // Direct execution with custom input
    }
}
```

#### StatefulAgUiAgent

Maintains conversation history and state locally:

```kotlin
class StatefulAgUiAgent(
    url: String,
    configure: StatefulAgentConfig.() -> Unit = {}
) : AgUiAgent(url, configure) {
    
    private val conversationHistory = mutableListOf<Message>()
    private var currentState: State = initialState
    
    suspend fun chat(message: String): Flow<State> {
        // Adds message to history
        // Includes full context in request
        // Updates local state
        // Returns incremental updates
    }
    
    fun clearHistory() {
        conversationHistory.clear()
        currentState = initialState
    }
    
    fun getHistory(): List<Message> = conversationHistory.toList()
}
```

#### Builder Functions

Convenience builders for common configurations:

```kotlin
// Bearer token authentication
val agent = agentWithBearer(
    url = "https://api.example.com/agent",
    token = "your-token-here"
)

// Agent with tool support
val toolAgent = agentWithTools(
    url = "https://api.example.com/agent",
    toolRegistry = toolRegistry {
        addTool(CalculatorToolExecutor())
        addTool(WeatherToolExecutor())
    }
) {
    bearerToken = "your-token"
    systemPrompt = "You are a helpful assistant"
}

// Stateful chat agent
val chatAgent = chatAgent(
    url = "https://api.example.com/agent",
    systemPrompt = "You are a conversational AI assistant"
) {
    bearerToken = "your-token"
    initialState = buildJsonObject {
        put("userName", "Developer")
        put("preferences", buildJsonObject {
            put("language", "en")
            put("timezone", "UTC")
        })
    }
}
```
