# AG-UI Kotlin SDK Overview

AG-UI Kotlin SDK is a Kotlin Multiplatform client library for connecting to AI agents that implement the [Agent User Interaction Protocol (AG-UI)](https://docs.ag-ui.com/). The library provides transport mechanisms, state management, and tool integration for communication between Kotlin applications and AI agents across Android, iOS, and JVM platforms.

## 📚 Complete Documentation

**[📖 Full SDK Documentation](../docs/sdk/kotlin/)**

The comprehensive documentation provides detailed coverage of:

- **[Getting Started](../docs/sdk/kotlin/overview.mdx)** - Installation, architecture, and quick start guide
- **[Client APIs](../docs/sdk/kotlin/client/)** - AgUiAgent, StatefulAgUiAgent, HttpAgent, and convenience builders  
- **[Core Types](../docs/sdk/kotlin/core/)** - Protocol messages, events, state management, and serialization
- **[Tools Framework](../docs/sdk/kotlin/tools/)** - Extensible tool execution system with registry and executors

## Architecture Summary

AG-UI Kotlin SDK follows the design patterns of the TypeScript SDK while leveraging Kotlin's multiplatform capabilities and coroutine-based concurrency:

- **kotlin-core**: Protocol types, events, and message definitions
- **kotlin-client**: HTTP transport, state management, and high-level agent APIs  
- **kotlin-tools**: Tool execution framework with registry and circuit breakers

The SDK maintains conceptual parity with the TypeScript implementation while providing native Kotlin idioms like sealed classes, suspend functions, and Kotlin Flows for streaming responses.
