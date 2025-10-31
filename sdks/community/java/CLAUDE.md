# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Build Commands
- **Full build**: `mvn clean compile` - Compiles all modules
- **Run tests**: `mvn test` - Executes unit tests across all modules
- **Full verification**:
- `mvn clean verify` - Runs complete build with tests and quality checks
- **Coverage analysis**: `mvn clean test -Pcoverage` - Runs tests with JaCoCo coverage reports
- **Code quality**: `mvn sonar:sonar` - Runs SonarCloud analysis (requires configuration)

### Testing Commands
- **Unit tests only**: `mvn surefire:test` - Runs unit tests using Surefire plugin
- **Integration tests**: `mvn failsafe:integration-test` - Runs integration tests using Failsafe plugin
- **Test a specific module**: `mvn test -pl packages/core` - Tests only the core module

### Package Management
- **Package without tests**: `mvn package -DskipTests` - Fast packaging
- **Deploy to GitHub Packages**: `mvn deploy` - Deploys artifacts to GitHub Packages repository

## Project Architecture

AG-UI-4J is an Agent User Interaction Protocol for Java that provides a framework for building AI agent interactions with streaming event-based communication.

### Module Structure

- **packages/core**: Core interfaces and models (`Agent`, `BaseMessage`, events)
- **packages/client**: Client library for consuming agent services
- **packages/http**: HTTP utilities and communication layer
- **packages/server**: Server-side implementation components
- **integrations/spring-ai**: Spring AI integration with `SpringAIAgent`
- **integrations/langchain4j**: LangChain4j integration with `Langchain4jAgent`
- **servers/spring**: Spring Boot server implementation
- **clients/ok-http**: OkHttp client implementation
- **utils/json**: JSON utilities with Jackson mixins
- **examples/**: Working examples for Spring AI and LangChain4j

### Core Architecture Patterns

#### Agent Pattern
The `Agent` interface (packages/core/src/main/java/com/agui/core/agent/Agent.java:49) defines the contract:
```java
CompletableFuture<Void> runAgent(RunAgentParameters parameters, AgentSubscriber subscriber);
```

All agents implement this interface for asynchronous execution with real-time event streaming.

#### Event-Driven Communication
The system uses streaming events for real-time updates:
- **Text events**: `TextMessageStartEvent`, `TextMessageContentEvent`, `TextMessageEndEvent`
- **Tool events**: `ToolCallStartEvent`, `ToolCallArgsEvent`, `ToolCallEndEvent`, `ToolCallResultEvent`
- **Run lifecycle**: `RunStartedEvent`, `RunFinishedEvent`, `RunErrorEvent`
- **Thinking events**: `ThinkingStartEvent`, `ThinkingEndEvent` with content events

#### Integration Strategy
- **SpringAIAgent**: Uses Spring AI's reactive streaming with `ChatClient` and `ToolCallback`
- **Langchain4jAgent**: Integrates with `StreamingChatModel` and `StreamingChatResponseHandler`
- Both agents extend `LocalAgent` base class for common functionality

#### Message System
Unified message types across all integrations:
- `SystemMessage`, `UserMessage`, `AssistantMessage`, `DeveloperMessage`, `ToolMessage`
- Message mappers convert between ag-ui-4j format and integration-specific formats

### Build Profiles
- **local** (default): Skips Javadoc and source generation for faster development
- **github-actions**: Enables full documentation generation for CI/CD
- **coverage**: Activates JaCoCo for code coverage analysis

### Java Version
- **Source/Target**: Java 17 (minimum)
- **Recommended**: Java 21 LTS

### Key Dependencies
- **Spring AI**: Chat models, tools, and advisors integration
- **LangChain4j**: Streaming chat models and tool execution
- **Jackson**: JSON serialization with custom mixins
- **JUnit 5**: Testing framework
- **AssertJ**: Fluent assertions for tests
- **Maven**: Build and dependency management