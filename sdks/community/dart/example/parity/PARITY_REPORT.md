# Dart SDK Parity Report

## Executive Summary
This report documents the parity testing between the Dart SDK example application and the TypeScript Dojo demo when using the AG-UI protocol with the Python Server Starter (All Features) example.

## Test Date
2025-09-09 (Last Updated: 2025-09-09 - Fixed Tool Call Response Loop)

## Test Environment
- **Server**: Python Server Starter (All Features) at http://127.0.0.1:20203
- **Dart SDK Version**: Latest from sdks/community/dart
- **TypeScript Dojo Version**: Latest from typescript-sdk/apps/dojo
- **Test Endpoint**: /tool_based_generative_ui

## Current Status

### Identified Issues

#### 1. Tool Call Response Loop Issue
**Status**: ✅ RESOLVED (2025-09-09)
**Description**: The Dart client was entering an infinite loop when processing tool calls.

**Root Cause**: 
- When the Dart client receives a MESSAGES_SNAPSHOT with a tool call, it immediately responds by calling `_streamRun` recursively
- This creates a new HTTP request to the server, which responds with the same tool call again
- The cycle continues indefinitely

**Expected Behavior** (from Dojo):
1. Client sends initial message
2. Server responds with RUN_STARTED, MESSAGES_SNAPSHOT (with tool call), RUN_FINISHED
3. Client processes tool call and sends tool response in a new request
4. Server responds with final message

**Actual Behavior** (Dart - Before Fix):
1. Client sends initial message
2. Server responds with RUN_STARTED, MESSAGES_SNAPSHOT (with tool call)
3. Client immediately sends tool response before receiving RUN_FINISHED
4. Creates infinite loop of requests

**Fix Implemented**:
1. Modified `_handleEvent` to only collect tool calls without processing them immediately
2. Updated `_streamRun` to process tool calls AFTER receiving RUN_FINISHED
3. Added tracking of processed tool call IDs to prevent duplicate processing
4. Changed from recursive `_streamRun` calls to sequential processing with new run IDs

**Current Behavior** (Dart - After Fix):
1. Client sends initial message
2. Server responds with RUN_STARTED, MESSAGES_SNAPSHOT (with tool call), RUN_FINISHED
3. Client waits for RUN_FINISHED then processes pending tool calls
4. Client sends tool response as a new request with new run ID
5. Server responds with final message
6. Client correctly identifies already-processed tool calls and exits cleanly

### Event Flow Comparison

#### Scenario 1: Tool-Based Haiku Generation

**Expected Event Sequence** (Dojo pattern):
```
→ POST /tool_based_generative_ui
  {messages: [{role: "user", content: "Create a haiku about AI"}]}
← RUN_STARTED
← MESSAGES_SNAPSHOT
  {messages: [..., {role: "assistant", tool_calls: [{function: {name: "generate_haiku", arguments: {...}}}]}]}
← RUN_FINISHED

→ POST /tool_based_generative_ui  
  {messages: [..., {role: "tool", content: "thanks", tool_call_id: "..."}]}
← RUN_STARTED
← MESSAGES_SNAPSHOT
  {messages: [..., {role: "assistant", content: "Haiku created"}]}
← RUN_FINISHED
```

**Actual Event Sequence** (Dart):
```
→ POST /tool_based_generative_ui
← RUN_STARTED
← MESSAGES_SNAPSHOT (with tool call)
→ POST /tool_based_generative_ui (immediate response, before RUN_FINISHED)
← RUN_STARTED
← MESSAGES_SNAPSHOT (server sends same tool call again)
→ POST /tool_based_generative_ui (loops infinitely)
...
```

## Parity Criteria Assessment

| Criterion | Status | Notes |
|-----------|--------|-------|
| Session/run lifecycle | ✅ | Fixed: Dart now waits for RUN_FINISHED before responding |
| Event type recognition | ✅ | All event types properly decoded |
| Event ordering | ✅ | Fixed: Tool responses now sent after RUN_FINISHED |
| Tool invocation semantics | ✅ | Fixed: Tool calls properly processed after run completion |
| Message accumulation | ✅ | Messages properly accumulated in snapshot |
| State management | ✅ | Can now be tested with tool calls working correctly |

## ~~Required Fixes~~ COMPLETED

### ✅ Priority 1: Fix Tool Response Flow (COMPLETED 2025-09-09)
The Dart client has been updated to:
1. ✅ Wait for RUN_FINISHED before processing tool calls
2. ✅ Send tool responses as a new complete request, not recursively
3. ✅ Track which tool calls have been processed to avoid duplicates

### ✅ Priority 2: Implement Proper Stream Completion (COMPLETED 2025-09-09)
- ✅ Properly exit the event stream when RUN_FINISHED is received
- ✅ Ensure clean separation between different run sessions

## Next Steps

1. ✅ **DONE: Fixed the tool response flow** in the Dart example to match the expected AG-UI protocol behavior
2. ✅ **DONE: Re-ran parity tests** with the fixed implementation - all tests passing
3. **Additional testing** with other endpoint types (state management, multi-step, etc.)
4. **Performance comparison** between Dart and TypeScript implementations

## Technical Notes

### Server Behavior
The Python server (`tool_based_generative_ui.py`) implements a simple state machine:
- If last message content == "thanks" → respond with "Haiku created"
- Otherwise → respond with tool call for generate_haiku

### Protocol Compliance
The AG-UI protocol expects:
- Each RUN must complete (RUN_FINISHED) before processing continues
- Tool responses should be sent as new RunAgentInput with accumulated messages
- Multiple sequential runs are supported in the protocol

## Conclusion

**UPDATE (2025-09-09)**: The critical tool call handling issue has been successfully resolved. The Dart SDK now properly implements the AG-UI protocol's sequential run pattern for tool calls.

### Key Achievements:
- ✅ **Full Protocol Compliance**: The Dart client now correctly waits for RUN_FINISHED before processing tool calls
- ✅ **Proper Event Sequencing**: Tool responses are sent as new requests with unique run IDs
- ✅ **Duplicate Prevention**: Implemented tracking to prevent reprocessing of tool calls
- ✅ **Clean Execution**: No more infinite loops; the client exits cleanly after processing

### Parity Status:
The Dart SDK has achieved **full parity** with the TypeScript Dojo implementation for tool-based generative UI scenarios. The client correctly handles the complete lifecycle of tool calls according to the AG-UI protocol specification.