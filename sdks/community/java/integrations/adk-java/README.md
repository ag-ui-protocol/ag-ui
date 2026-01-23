# ADK-Java Middleware for AG-UI Protocol

This Java middleware enables [Google ADK](https://google.github.io/adk-docs/) agents to be used with the AG-UI Protocol, providing a bridge between the two frameworks.

## Prerequisites

- A [Gemini API Key](https://makersuite.google.com/app/apikey). The examples assume that this is exported via the `GOOGLE_API_KEY` environment variable.
- Java 17 or higher.
- Maven 3.6 or higher.

## Quick Start

To use this integration, you need to:

1.  Clone the [AG-UI repository](https://github.com/ag-ui-protocol/ag-ui).

    ```bash
    git clone https://github.com/ag-ui-protocol/ag-ui.git
    ```

2.  Build the necessary server packages from the root directory.

    ```bash
    pnpm install
    pnpm build --filter=@ag-ui/server
    ```

3.  Install the `adk-java` package into your local Maven repository.

    ```bash
    cd sdks/community/java/integrations/adk-java
    mvn clean install
    ```

## Integration Guide

For detailed instructions on how to integrate this library with Dependency Injection frameworks like Spring Boot, Quarkus, or in a pure Java application, please see our [**Integration Guide**](INTEGRATION_GUIDE.md).
The `SessionManager` is part of this integration library (and not the core Google ADK) to provide essential, production-ready features for a server environment out-of-the-box. The core ADK provides a low-level, unopinionated `SessionService` for basic data storage. Our `SessionManager` adds a higher-level management layer on top, handling timeouts, automatic cleanup, and integration with the `MemoryService`. This separation keeps the core ADK simple and flexible, while our library provides the robust features needed for a web application.

For more details on the architecture of this integration, see [ARCHITECTURE.md](./ARCHITECTURE.md).