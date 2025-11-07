# Claude Agent SDK Integration Architecture

This document describes the architecture and design of the Claude Agent SDK integration that bridges Claude agents with the AG-UI Protocol.

## High-Level Architecture

```
AG-UI Protocol          Claude Middleware          Claude Agent SDK
     │                        │                           │
RunAgentInput ──────> ClaudeAgent.run() ──────> SDK Client/Query
     │                        │                           │
     │                 EventTranslator                    │
     │                        │                           │
BaseEvent[] <──────── translate events <──────── Response[]
```

## Core Components

### ClaudeAgent (`claude_agent.py`)
The main orchestrator that:
- Manages agent lifecycle and session state
- Handles the bridge between AG-UI Protocol and Claude SDK
- Coordinates tool execution
- Supports both persistent sessions and stateless query mode

### EventTranslator (`event_translator.py`)
Converts between event formats:
- Claude SDK responses → AG-UI protocol events (16 standard event types)
- Maintains proper message boundaries
- Handles streaming text content
- Per-execution instances for thread safety

### SessionManager (`session_manager.py`)
Singleton pattern for centralized session control:
- Automatic session cleanup with configurable timeouts
- Session isolation per user
- Message tracking to avoid duplicates
- State management

### ToolAdapter (`tool_adapter.py`)
Tool format conversion:
- AG-UI Tool → Claude SDK tool format
- Tool call extraction and parsing
- Long-running tool detection

### ExecutionState (`execution_state.py`)
Tracks background Claude executions:
- Manages asyncio tasks running Claude SDK calls
- Event queue for streaming results
- Execution timing and completion tracking
- Tool call state management

## Event Flow

1. **Client Request**: AG-UI Protocol `RunAgentInput` received
2. **Session Resolution**: SessionManager finds or creates session
3. **Message Processing**: Unseen messages identified and processed
4. **Agent Execution**: Claude SDK called with messages and tools
5. **Event Translation**: Claude responses converted to AG-UI events
6. **Streaming Response**: Events streamed back via SSE or other transport

## Key Design Patterns

### Session Management
- **Persistent Mode**: Uses ClaudeSDKClient for session continuity
- **Stateless Mode**: Uses query() method with manual context management

### Tool Handling
- **Client Tools**: Long-running tools executed on frontend
- **Backend Tools**: Synchronous tools executed on backend
- **Tool Results**: Handled through message routing

### Event Streaming
- Background execution with event queue
- Non-blocking async/await throughout
- Proper cleanup on errors or timeouts

## Thread Safety

- Per-execution EventTranslator instances
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

## Implementation Notes

✅ **Implementation Complete**: The implementation has been updated based on the actual [Claude Agent SDK API](https://docs.claude.com/zh-CN/api/agent-sdk/python#claudesdkclient).

Key implementation details:

1. **SDK Initialization**: ✅ Implemented `_get_claude_client()` with `ClaudeSDKClient` and `query()` support
2. **Message Format**: ✅ Implemented prompt extraction (`_extract_user_prompt()`) for Claude SDK string-based API
3. **Response Handling**: ✅ Implemented `_call_claude_sdk()` supporting both persistent and stateless modes
4. **Tool Format**: ✅ Implemented `ToolAdapter` with `SdkMcpTool` and `create_sdk_mcp_server()`
5. **Event Translation**: ✅ Implemented `EventTranslator` handling `Message`, `AssistantMessage`, `TextBlock`, `ToolUseBlock`, `ToolResultBlock`

The implementation follows the actual Claude Agent SDK patterns and should work with the real SDK. Some fine-tuning may be needed based on real-world testing.

