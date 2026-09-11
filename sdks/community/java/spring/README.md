# ag-ui-spring

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Java](https://img.shields.io/badge/Java-17%2B-orange.svg)](https://adoptium.net/)

Spring integrations for the [**AG-UI protocol**](https://docs.ag-ui.com), built on
top of the framework-agnostic `ag-ui` Java
library.

This repository is kept separate so the core `ag-ui` modules stay dependency-light;
the Spring (and Reactor) dependency tree lives only here.

## Layout

The integration is split into two independently-released **sub-reactors**, one per
framework line. A thin top-level aggregator (`pom.xml`) builds and tests both in one
pass (`mvn verify`) but is not itself published.

- [`spring-boot/`](spring-boot) — the **Spring Boot server** line (`ag-ui-spring-boot-parent`, tracks Spring Boot `4.1.x`).
- [`spring-ai/`](spring-ai) — the **Spring AI** line (`ag-ui-spring-ai-parent`, tracks Spring AI `2.x`); its Boot starters depend on the server line.

## Modules

| Module | Artifact | Version line | Description |
|--------|----------|--------------|-------------|
| [`spring-boot/spring-server-core`](spring-boot/spring-server-core) | `ag-ui-spring-server-core` | tracks **Spring Boot** (`4.1.x`) | Framework-agnostic code shared by both servers: the Jackson-backed `Serializer` (configured for the AG-UI sealed hierarchies) and `AgentNotFoundException`. No Spring dependency. |
| [`spring-boot/spring-webflux-server`](spring-boot/spring-webflux-server) | `ag-ui-spring-webflux-server` | tracks **Spring Boot** (`4.1.x`) | A reactive **Spring WebFlux** endpoint that streams an `Agent`'s events as Server-Sent Events, plus Spring Boot auto-configuration. Uses the shared serializer from `spring-server-core`. |
| [`spring-boot/spring-webmvc-server`](spring-boot/spring-webmvc-server) | `ag-ui-spring-webmvc-server` | tracks **Spring Boot** (`4.1.x`) | The Servlet (**Spring WebMVC**) equivalent, streaming an `Agent`'s events via an `SseEmitter`. Same routing and shared serializer — pick this if your app is Servlet-based rather than reactive. |
| [`spring-boot/spring-webflux-boot-starter`](spring-boot/spring-webflux-boot-starter) | `ag-ui-spring-webflux-boot-starter` | tracks **Spring Boot** (`4.1.x`) | Drop-in starter over `spring-webflux-server`: add it and define one `Agent` bean to get a working reactive `/agent` endpoint. |
| [`spring-boot/spring-webmvc-boot-starter`](spring-boot/spring-webmvc-boot-starter) | `ag-ui-spring-webmvc-boot-starter` | tracks **Spring Boot** (`4.1.x`) | Drop-in starter over `spring-webmvc-server`: the Servlet equivalent of the WebFlux starter. |
| [`spring-ai/spring-ai`](spring-ai/spring-ai) | `ag-ui-spring-ai` | tracks **Spring AI** (`2.x`) | Adapts a Spring AI `ChatClient` into an AG-UI `Agent`, translating its streamed response into the AG-UI event lifecycle. |
| [`spring-ai/spring-ai-spring-boot-starter`](spring-ai/spring-ai-spring-boot-starter) | `ag-ui-spring-ai-spring-boot-starter` | tracks **Spring AI** (`2.x`) | Zero-code starter (**reactive / WebFlux**): auto-registers a `SpringAiAgent` from the auto-configured `ChatClient.Builder` and exposes it at `/agent`. |
| [`spring-ai/spring-ai-webmvc-boot-starter`](spring-ai/spring-ai-webmvc-boot-starter) | `ag-ui-spring-ai-webmvc-boot-starter` | tracks **Spring AI** (`2.x`) | The **Servlet / WebMVC** equivalent zero-code Spring AI starter: same auto-registration, served over an `SseEmitter`-backed `/agent`. |

## Versioning

The two lines are **versioned and released independently**, because each tracks a
different framework's compatibility:

- the **spring-boot** line (`ag-ui-spring-boot-parent`) is versioned on the **Spring Boot** line it targets (e.g. `4.1.0`); every module in it shares that version;
- the **spring-ai** line (`ag-ui-spring-ai-parent`) is versioned on the **Spring AI** line it targets (e.g. `2.0.0`); every module in it shares that version.

Each sub-reactor is self-contained (it owns its framework BOM and build/release
config), so the two lines can be bumped and released on separate cadences. Mix and
match the versions you need.

### Releasing

Both lines publish to Maven Central through the monorepo's
[`publish-release.yml`](../../../../.github/workflows/publish-release.yml) workflow,
which detects a version bump in each sub-reactor's `pom.xml` (registered in
`scripts/release/release.config.json` as the `integration-spring-boot-java` and
`integration-spring-ai-java` scopes) and deploys that reactor with the `release`
Maven profile. That profile flattens each module's POM (inlining the reactor parent),
so the two lines publish as self-contained artifacts and the aggregators need not be
resolvable by consumers.

The **spring-ai** line's Boot starters depend on the **spring-boot** server modules,
so the server line is built and deployed first (the workflow preserves this order).
The `ag-ui` artifacts (`java-core`, `:java-server`) must already be on Central — the
Central Portal rejects SNAPSHOT dependencies.

## Requirements

- **Java 17+**
- **Spring Boot 4.1.x** / **Spring AI 2.x**
- The `ag-ui` artifacts (`com.ag-ui.community:java-core`, `:java-server`) — resolved from
  Maven Central (currently `0.1.1`; see `ag-ui.version` in each sub-reactor POM).

## Quick start

Pick the starter that matches what you have:

**Expose your own agent** — add `ag-ui-spring-webflux-boot-starter` (reactive) or
`ag-ui-spring-webmvc-boot-starter` (Servlet) and define one bean:

```java
@Bean
Agent agent() {
    return input -> subscriber -> { /* emit events */ };
}
```

**Expose a Spring AI model with no code** — add `ag-ui-spring-ai-spring-boot-starter`
(reactive / WebFlux) or `ag-ui-spring-ai-webmvc-boot-starter` (Servlet / WebMVC) and
a Spring AI model (e.g. `spring-ai-starter-model-openai`). A `SpringAiAgent` is
auto-registered from the auto-configured `ChatClient.Builder` and served
automatically.

Either way the endpoint is at `/agent` (override with `ag-ui.server.path`); point
the `HttpAgent` client at it.

## Building

```bash
mvn clean install
```

> Requires the `ag-ui` artifacts in your local repository (or a configured
> repository) first. Until `ag-ui` is published to Maven Central, run
> `mvn install` in the `ag-ui` project.

## Contributing

See the organization's
Contributing Guide
and Code of Conduct.

## License

Licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
