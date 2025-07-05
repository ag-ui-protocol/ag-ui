# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### TypeScript SDK (Primary development)
```bash
# Working directory: typescript-sdk/
pnpm install                    # Install dependencies
pnpm run build                  # Build all packages
pnpm run build:clean           # Clean build (removes node_modules first)
pnpm run test                  # Run all tests
pnpm run lint                  # Run linting
pnpm run check-types           # Type checking
pnpm run format                # Format code with prettier
pnpm run dev                   # Start development mode
```

### Python SDK
```bash
# Working directory: python-sdk/
poetry install                 # Install dependencies
poetry run python -m unittest discover tests -v  # Run tests
```

### Dojo Demo App
```bash
# Working directory: typescript-sdk/apps/dojo/
pnpm run dev                   # Start development server
pnpm run build                 # Build for production
pnpm run lint                  # Run linting
```

### Individual Package Testing
```bash
# From typescript-sdk/ root
pnpm run test --filter=@ag-ui/core     # Test specific package
pnpm run test --filter=@ag-ui/client   # Test client package
```

## Architecture Overview

AG-UI is a monorepo with dual-language SDKs implementing an event-based protocol for agent-user interaction:

### Core Components
- **Event System**: ~16 standard event types for agent communication (TEXT_MESSAGE_START, TOOL_CALL_START, STATE_SNAPSHOT, etc.)
- **Protocol**: HTTP reference implementation with flexible middleware layer
- **Transport Agnostic**: Works with SSE, WebSockets, webhooks, etc.
- **Bidirectional**: Agents can emit events and receive inputs

### TypeScript SDK Structure
```
typescript-sdk/
├── packages/
│   ├── core/           # Core types and events (EventType enum, Message types)
│   ├── client/         # AbstractAgent, HTTP client implementation
│   ├── encoder/        # Event encoding/decoding utilities
│   ├── proto/          # Protocol buffer definitions
│   └── cli/            # Command line interface
├── integrations/       # Framework connectors (LangGraph, CrewAI, Mastra, etc.)
├── apps/dojo/          # Demo showcase app (Next.js)
```

### Python SDK Structure
```
python-sdk/
├── ag_ui/
│   ├── core/           # Core types and events (mirrors TypeScript)
│   └── encoder/        # Event encoding utilities
```

### Key Architecture Patterns
- **Event-Driven**: All agent interactions flow through standardized events
- **Framework Agnostic**: Integrations adapt various AI frameworks to AG-UI protocol
- **Type Safety**: Heavy use of Zod (TS) and Pydantic (Python) for validation
- **Streaming**: Real-time event streaming with RxJS observables
- **Middleware**: Flexible transformation layer for event processing

### Core Event Flow
1. Agent receives `RunAgentInput` (messages, state, tools, context)
2. Agent emits events during execution (TEXT_MESSAGE_*, TOOL_CALL_*, STATE_*)
3. Events are transformed through middleware pipeline
4. Events are applied to update agent state and messages
5. Final state/messages are returned to UI

### Framework Integration Points
- Each integration in `integrations/` adapts a specific AI framework
- Integrations translate framework-specific events to AG-UI standard events
- Common patterns: HTTP endpoints, SSE streaming, state management

## Development Notes

- **Monorepo**: Uses pnpm workspaces + Turbo for build orchestration
- **Testing**: Jest for unit tests, test files use `*.test.ts` pattern
- **Build**: tsup for package building, concurrent builds via Turbo
- **Linting**: ESLint configuration, run before commits
- **Type Safety**: Strict TypeScript, run `check-types` before commits
- **Node Version**: Requires Node.js >=18

## Common Patterns

- All events extend `BaseEvent` with type discriminated unions
- Agent implementations extend `AbstractAgent` class
- State updates use JSON Patch (RFC 6902) for deltas
- Message format follows OpenAI-style structure
- Tool calls use OpenAI-compatible format