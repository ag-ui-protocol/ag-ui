# ADK Middleware Architecture

This document describes the architecture and design of the ADK Middleware that bridges Google ADK agents with the AG-UI Protocol.

## High-Level Architecture

```
AG-UI Protocol          ADK Middleware           Google ADK
     │                        │                       │
RunAgentInput ──────> ADKAgent.run() ──────> Runner.run_async()
     │                        │                       │
     │                 EventTranslator                │
     │                        │                       │
BaseEvent[] <──────── translate events <──────── Event[]
```

## Core Components

### ADKAgent (`adk_agent.py`)
The main orchestrator that:
- Manages agent lifecycle and session state
- Handles the bridge between AG-UI Protocol and ADK
- Coordinates tool execution through proxy tools
- Implements direct agent embedding pattern

### EventTranslator (`event_translator.py`)
Converts between event formats:
- ADK events → AG-UI protocol events (16 standard event types)
- Maintains proper message boundaries
- Handles streaming text content
- Per-session instances for thread safety

### SessionManager (`session_manager.py`)
Singleton pattern for centralized session control:
- Automatic session cleanup with configurable timeouts
- Session isolation per user
- Memory service integration for session persistence
- Resource management and limits

### ExecutionState (`execution_state.py`)
Tracks background ADK executions:
- Manages asyncio tasks running ADK agents
- Event queue for streaming results
- Execution timing and completion tracking
- Tool call state management

### ClientProxyTool (`client_proxy_tool.py`)
Individual tool proxy implementation:
- Wraps AG-UI tools for ADK compatibility
- Emits tool events to client
- Currently all tools are long-running
- Integrates with ADK's tool system

### ClientProxyToolset (`client_proxy_toolset.py`)
Manages collections of proxy tools:
- Dynamic toolset creation per request
- Fresh tool instances for each execution
- Combines client and backend tools

## Event Flow

1. **Client Request**: AG-UI Protocol `RunAgentInput` received
2. **Session Resolution**: SessionManager finds or creates session
3. **Agent Execution**: ADK Runner executes agent with context
4. **Tool Handling**: ClientProxyTools emit events for client-side execution
5. **Event Translation**: ADK events converted to AG-UI events
6. **Streaming Response**: Events streamed back via SSE or other transport

## Key Design Patterns

### Direct Agent Embedding
```python
# Agents are directly embedded in ADKAgent instances
agent = ADKAgent(
    adk_agent=my_adk_agent,  # Direct reference
    app_name="my_app",
    user_id="user123"
)
```

### Service Dependency Injection
The middleware uses dependency injection for ADK services:
- Session service (default: InMemorySessionService)
- Memory service (optional, enables session persistence)
- Artifact service (default: InMemoryArtifactService)
- Credential service (default: InMemoryCredentialService)

### Tool Proxy Pattern
All client-supplied tools are wrapped as long-running ADK tools:
- Emit events for client-side execution
- Can be combined with backend tools
- Unified tool handling interface

### Session Lifecycle
1. Session created on first request
2. Maintained across multiple runs
3. Automatic cleanup after timeout
4. Optional persistence to memory service

## Thread Safety

- Per-session EventTranslator instances
- Singleton SessionManager with proper locking
- Isolated execution states per thread
- Thread-safe event queues

## Error Handling

- RunErrorEvent for various failure scenarios
- Proper async exception handling
- Resource cleanup on errors
- Timeout management at multiple levels

## Performance Considerations

- Async/await throughout for non-blocking operations
- Event streaming for real-time responses
- Configurable concurrent execution limits
- Automatic stale execution cleanup
- Efficient event queue management

## Future Enhancements

- Additional tool execution modes
- Enhanced state synchronization
- More sophisticated error recovery
- Performance optimizations
- Extended protocol support