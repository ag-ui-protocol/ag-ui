# ADK Middleware Implementation Plan for AG-UI Protocol

## Overview
This plan outlines the implementation of a Python middleware layer that bridges the AG-UI Protocol with Google's Agent Development Kit (ADK). The middleware will be implemented as an integration within the forked ag-ui-protocol repository.

## Directory Structure
```
ag-ui-protocol/
└── typescript-sdk/
    └── integrations/
        └── adk-middleware/
            ├── src/
            │   ├── __init__.py
            │   ├── adk_agent.py
            │   ├── agent_registry.py
            │   ├── event_translator.py
            │   ├── session_manager.py
            │   └── utils/
            │       ├── __init__.py
            │       └── converters.py
            ├── examples/
            │   ├── __init__.py
            │   ├── simple_agent.py
            │   ├── multi_agent.py
            │   └── production_setup.py
            ├── tests/
            │   ├── __init__.py
            │   ├── test_adk_agent.py
            │   ├── test_agent_registry.py
            │   ├── test_event_translator.py
            │   └── test_session_manager.py
            ├── README.md
            ├── requirements.txt
            ├── setup.py
            ├── setup_dev.sh
            └── .gitignore
```

## Implementation Phases

### Phase 0: Foundation and Registry (Days 1-2)
1. Create directory structure
2. Implement `setup.py` with proper path handling for python-sdk
3. Implement `AgentRegistry` singleton
4. Create base `ADKAgent` class structure
5. Set up development environment scripts

### Phase 1: Core Text Messaging with Session Management (Days 3-5)
1. Implement `SessionLifecycleManager` with timeout handling
2. Complete `ADKAgent.run()` method
3. Implement basic `EventTranslator` for text messages
4. Add session cleanup background task
5. Create simple example demonstrating text conversation

### Phase 2: Message History and State (Days 6-7)
1. Implement message history conversion in `converters.py`
2. Add state synchronization in `EventTranslator`
3. Handle STATE_DELTA and STATE_SNAPSHOT events
4. Update examples to show state management

### Phase 3: Tool Integration (Days 8-9)
1. Extend `EventTranslator` for tool events
2. Handle function calls and responses
3. Support tool registration from RunAgentInput
4. Create tool-enabled example

### Phase 4: Multi-Agent Support (Days 10-11)
1. Implement agent transfer detection
2. Handle conversation branches
3. Support escalation flows
4. Create multi-agent example

### Phase 5: Advanced Features (Days 12-14)
1. Integrate artifact service
2. Add memory service support
3. Implement credential service handling
4. Create production example with all services

### Phase 6: Testing and Documentation (Days 15-16)
1. Complete unit tests for all components
2. Add integration tests
3. Finalize documentation
4. Create deployment guide

## Key Design Decisions

### Agent Mapping
- Use singleton `AgentRegistry` for centralized agent mapping
- AG-UI `agent_id` maps to ADK agent instances
- Support static registry, factory functions, and default fallback

### User Identification
- Support both static `user_id` and dynamic extraction
- Default extractor checks context, state, and forwarded_props
- Thread ID used as fallback with prefix

### Session Management
- Use thread_id as session_id
- Use agent_id as app_name in ADK
- Automatic cleanup of expired sessions
- Configurable timeouts and limits

### Event Translation
- Stream events using AsyncGenerator
- Convert ADK Events to AG-UI BaseEvent types
- Maintain proper event sequences (START/CONTENT/END)
- Handle partial events for streaming

### Service Configuration
- Support all ADK services (session, artifact, memory, credential)
- Default to in-memory implementations for development
- Allow custom service injection for production

## Testing Strategy

### Unit Tests
- Test each component in isolation
- Mock ADK dependencies
- Verify event translation accuracy
- Test session lifecycle management

### Integration Tests
- Use InMemoryRunner for end-to-end testing
- Test multi-turn conversations
- Verify state synchronization
- Test tool calling flows

### Example Coverage
- Simple single-agent conversation
- Multi-agent with transfers
- Tool-enabled agents
- Production setup with all services

## Success Criteria
1. Basic text conversations work end-to-end
2. Sessions are properly managed with timeouts
3. State synchronization works bidirectionally
4. Tool calls are properly translated
5. Multi-agent transfers function correctly
6. All ADK services are accessible
7. Comprehensive test coverage (>80%)
8. Clear documentation and examples

## Dependencies
- ag-ui (python-sdk from parent repo)
- google-adk>=0.1.0
- pydantic>=2.0
- pytest>=7.0 (for testing)
- pytest-asyncio>=0.21 (for async tests)

## Deliverables
1. Complete middleware implementation
2. Unit and integration tests
3. Example applications
4. Documentation (README, docstrings)
5. Setup and deployment scripts