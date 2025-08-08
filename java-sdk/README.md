# Agent User Interaction Protocol Java SDK

The Java SDK for the [Agent User Interaction Protocol](https://ag-ui.com).

For more information visit the [official documentation](https://docs.ag-ui.com/).

## Overview

The AG-UI Java SDK provides a comprehensive set of tools for implementing the Agent User Interaction Protocol in Java applications. It includes core protocol definitions, client implementations, HTTP transport layers, and Spring Framework integrations.

## Requirements

- Java 18 or higher (Java 21 for Spring integration)
- Maven 3.6 or higher

## Packages

### Libraries

|Name|Description|Status|Version|
|---|---|---|---|
|Core|AG-UI Core SDK|In Progress|0.0.1-SNAPSHOT|
|Client|Client Agent implementation|In Progress|0.0.1-SNAPSHOT|

### Client

|Http|Http Agent integration|In Progres|0.0.1-SNAPSHOT|
|---|---|---|---|
|Ok-Http|Ok-Http Client integration|In Progress|0.0.1-SNAPSHOT|
|Spring-Http|Spring Http Client integration|In Progress|0.0.1-SNAPSHOT|

### Server
|Name|Description|Status|Version|
|---|---|---|---|
|Spring AI|Spring AI Server Integration|In Progress|0.0.1-SNAPSHOT|
|Langchain4j|Langchain 4j Agent Integration|TODO|-|


## Installation

### Maven

Add the following dependency to your `pom.xml`:

```xml
<dependency>
    <groupId>io.workm8.ag-ui</groupId>
    <artifactId>core</artifactId>
    <version>0.0.1-SNAPSHOT</version>
</dependency>
```

### Building from Source

```bash
git clone <repository-url>
cd workm8/ag-ui/java-sdk
mvn clean install
```

## Available Packages

### Core Package (`core`)

The core package contains the fundamental protocol definitions and interfaces.

```xml
<dependency>
    <groupId>io.workm8.ag-ui</groupId>
    <artifactId>core</artifactId>
    <version>0.0.1-SNAPSHOT</version>
</dependency>
```

### Client Package (`client`)

Provides client-side implementations for interacting with AG-UI services.

```xml
<dependency>
    <groupId>io.workm8.ag-ui</groupId>
    <artifactId>client</artifactId>
    <version>0.0.1-SNAPSHOT</version>
</dependency>
```

### HTTP Transport (`http`)

HTTP transport layer implementation for AG-UI protocol communication.

```xml
<dependency>
    <groupId>io.workm8.ag-ui</groupId>
    <artifactId>http</artifactId>
    <version>0.0.1-SNAPSHOT</version>
</dependency>
```

### OkHttp Integration (`ok-http`)

OkHttp-based HTTP client implementation for AG-UI.

```xml
<dependency>
    <groupId>io.workm8.ag-ui</groupId>
    <artifactId>ok-http</artifactId>
    <version>0.0.1-SNAPSHOT</version>
</dependency>
```

### Spring Integration (`spring`)

Spring Framework integration for AG-UI protocol.

```xml
<dependency>
    <groupId>io.workm8.ag-ui</groupId>
    <artifactId>spring</artifactId>
    <version>0.0.1-SNAPSHOT</version>
</dependency>
```

## Quick Start



## Development

### Running Tests

```bash
# Run all tests
mvn test

# Run tests for a specific module
cd packages/core
mvn test
```

### Code Coverage

The project uses JaCoCo for code coverage analysis. Coverage reports are generated automatically during the test phase.

```bash
mvn clean test
```

Coverage reports can be found in `target/site/jacoco/` for each module.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.

## Support

For support and questions:

- Documentation: [https://docs.ag-ui.com/](https://docs.ag-ui.com/)
- Issues: [GitHub Issues](https://github.com/your-repo/issues)
- Email: pascal.wilbrink@gmail.com

## Maintainers

- **Pascal Wilbrink** - *Maintainer & Developer* - [@pascalwilbrink](https://github.com/pascalwilbrink)

