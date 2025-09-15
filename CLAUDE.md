# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### TypeScript SDK (Main Development)
```bash
# Navigate to typescript-sdk directory for all TypeScript work
cd typescript-sdk

# Install dependencies (using pnpm)
pnpm install

# Build all packages
pnpm build

# Run development mode
pnpm dev

# Run linting
pnpm lint

# Run type checking
pnpm check-types

# Run tests
pnpm test

# Format code
pnpm format

# Clean build artifacts
pnpm clean

# Full clean build
pnpm build:clean
```

### Python SDK
```bash
# Navigate to python-sdk directory
cd python-sdk

# Install dependencies (using poetry)
poetry install

# Run tests
python -m unittest discover tests

# Build distribution
poetry build
```

### Running Specific Integration Tests
```bash
# For TypeScript packages/integrations
cd typescript-sdk/packages/<package-name>
pnpm test

# For running a single test file
cd typescript-sdk/packages/<package-name>
pnpm test -- path/to/test.spec.ts
```

## High-Level Architecture

AG-UI is an event-based protocol that standardizes agent-user interactions. The codebase is organized as a monorepo with the following structure:

### Core Protocol Architecture
- **Event-Driven Communication**: All agent-UI communication happens through typed events (BaseEvent and its subtypes)
- **Transport Agnostic**: Protocol supports SSE, WebSockets, HTTP binary, and custom transports
- **Observable Pattern**: Uses RxJS Observables for streaming agent responses

### Key Abstractions
1. **AbstractAgent**: Base class that all agents must implement with a `run(input: RunAgentInput) -> Observable<BaseEvent>` method
2. **HttpAgent**: Standard HTTP client supporting SSE and binary protocols for connecting to agent endpoints
3. **Event Types**: Lifecycle events (RUN_STARTED/FINISHED), message events (TEXT_MESSAGE_*), tool events (TOOL_CALL_*), and state management events (STATE_SNAPSHOT/DELTA)

### Repository Structure
- `/typescript-sdk/`: Main TypeScript implementation
  - `/packages/`: Core protocol packages (@ag-ui/core, @ag-ui/client, @ag-ui/encoder, @ag-ui/proto)
  - `/integrations/`: Framework integrations (langgraph, mastra, crewai, etc.)
  - `/apps/`: Example applications including the AG-UI Dojo demo viewer
- `/python-sdk/`: Python implementation of the protocol
- `/docs/`: Documentation site content

### Integration Pattern
Each framework integration follows a similar pattern:
1. Implements the AbstractAgent interface
2. Translates framework-specific events to AG-UI protocol events
3. Provides both TypeScript client and Python server implementations
4. Includes examples demonstrating key AG-UI features (agentic chat, generative UI, human-in-the-loop, etc.)

### State Management
- Uses STATE_SNAPSHOT for complete state representations
- Uses STATE_DELTA with JSON Patch (RFC 6902) for efficient incremental updates
- MESSAGES_SNAPSHOT provides conversation history

### Multiple Sequential Runs
- AG-UI supports multiple sequential runs in a single event stream
- Each run must complete (RUN_FINISHED) before a new run can start (RUN_STARTED)
- Messages accumulate across runs (e.g., messages from run1 + messages from run2)
- State continues to evolve across runs unless explicitly reset with STATE_SNAPSHOT
- Run-specific tracking (active messages, tool calls, steps) resets between runs

### Development Workflow
- Turbo is used for monorepo build orchestration
- Each package has independent versioning
- Integration tests demonstrate protocol compliance
- The AG-UI Dojo app showcases all protocol features with live examples