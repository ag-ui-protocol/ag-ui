# Integration Guide

This guide provides instructions and examples for integrating the AG-UI ADK into your applications.

## 1. Integrating with Spring WebFlux for Server-Sent Events (SSE)

This section provides a production-grade integration pattern for Spring Boot applications. The `AguiAdkRunnerAdapter` accepts the per-request `userId` as an explicit argument to `runAgent(...)`, so the WebFlux handler resolves the authenticated principal in the Reactor pipeline (where the `ContextView` is live) and passes the resolved value across the Reactor↔RxJava boundary as a plain `String`.

### 1.1. Add Dependencies

Add the necessary dependencies to your `pom.xml`.

`adk-java` declares `com.google.adk:google-adk` as a **`provided`** dependency — consumers must add it explicitly. This lets you pick the google-adk version that matches your project (or whatever another dependency already pulls in) without having to wait for a re-release of `adk-java` every time Google publishes a new version.

**`pom.xml`**
```xml
<dependency>
    <groupId>com.ag-ui</groupId>
    <artifactId>adk-java</artifactId>
    <version>1.4.0</version>
</dependency>
<!-- REQUIRED: adk-java declares google-adk as provided, so you supply it here. -->
<dependency>
    <groupId>com.google.adk</groupId>
    <artifactId>google-adk</artifactId>
    <version>1.4.0</version>  <!-- any version compatible with your code -->
</dependency>

<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-webflux</artifactId>
</dependency>
<dependency>
    <groupId>io.projectreactor.addons</groupId>
    <artifactId>reactor-adapter</artifactId>
</dependency>
```

Spring Security is **optional** — it's only needed if you want to authenticate requests and source the `userId` from the authenticated principal. See § 1.4 for the wiring snippet.

`adk-java` is built and tested against `google-adk 1.4.0`. Newer minor/patch versions are expected to be source-compatible; if Google ships a breaking change, you can pin `google-adk` to a known-good version while waiting for a new `adk-java` release.

### 1.2. Configure Beans in Spring

Define the ADK-related beans in a `@Configuration` class. There is no `userIdExtractor` bean and no SSE-converter `BiFunction` bean — the userId is per-call (resolved in the handler) and the SSE conversion lives inline next to the handler that performs it.

**`AdkConfiguration.java`**
```java
package com.your.package.config;

import com.agui.adk.AguiAdkRunnerAdapter;
import com.agui.adk.SessionManager;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.agents.RunConfig;
import com.google.adk.artifacts.BaseArtifactService;
import com.google.adk.artifacts.InMemoryArtifactService;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.memory.InMemoryMemoryService;
import com.google.adk.runner.BaseAgent;
import com.google.adk.runner.Runner;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.InMemorySessionService;
import com.google.adk.util.ObjectMapperFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;

import java.time.Duration;

@Configuration
public class AdkConfiguration {

    @Bean
    public BaseArtifactService artifactService() {
        return new InMemoryArtifactService();
    }

    @Bean
    public BaseMemoryService memoryService() {
        return new InMemoryMemoryService();
    }

    @Bean
    public RunConfig runConfig() {
        return RunConfig.builder()
                .setStreamingMode(RunConfig.StreamingMode.SSE)
                .build();
    }

    @Bean
    public BaseSessionService sessionService() {
        return new InMemorySessionService();
    }

    @Bean
    public AguiAdkRunnerAdapter aguiAdkRunnerAdapter(Runner runner,
                                                     SessionManager sessionManager,
                                                     RunConfig runConfig) {
        return new AguiAdkRunnerAdapter(runner, sessionManager, runConfig);
    }

    @Bean
    @Primary
    public ObjectMapper objectMapper() {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectMapperFactory.addMixins(objectMapper);
        return objectMapper;
    }

    @Bean
    public Runner runner(BaseAgent assistantAgent,
                         BaseArtifactService artifactService,
                         BaseSessionService sessionService,
                         BaseMemoryService memoryService) {
        return new Runner(
                assistantAgent,
                "appName",
                artifactService,
                sessionService,
                memoryService);
    }

    @Bean(destroyMethod = "shutdown")
    public SessionManager sessionManager(BaseSessionService sessionService, BaseMemoryService memoryService) {
        return new SessionManager(
                sessionService,
                memoryService,
                Duration.ofMinutes(20), // Session timeout
                Duration.ofMinutes(5)   // Cleanup interval
        );
    }
}
```

### 1.3. Implement the Handler

Inject the `AguiAdkRunnerAdapter` and the `ObjectMapper`. The adapter accepts the `userId` as a **`Single<String>`** so any reactive source works — Spring Security, a remote auth lookup, a database, anything `Mono`-shaped.

The example below uses `ServerRequest.principal()` (a standard WebFlux method that does **not** require Spring Security on the classpath) with a per-thread anonymous fallback. The Reactor `Mono<String>` is bridged to RxJava `Single<String>` for the adapter API.

**`ChatHandler.java`**
```java
package com.your.package.web;

import com.agui.adk.AguiAdkRunnerAdapter;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.BaseEvent;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.adapter.rxjava.RxJava3Adapter;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.security.Principal;

@Component
public class ChatHandler {

    private static final Logger logger = LoggerFactory.getLogger(ChatHandler.class);

    private final AguiAdkRunnerAdapter adapter;
    private final ObjectMapper objectMapper;

    public ChatHandler(AguiAdkRunnerAdapter adapter, ObjectMapper objectMapper) {
        this.adapter = adapter;
        this.objectMapper = objectMapper;
    }

    public Mono<ServerResponse> handleRun(ServerRequest request) {
        return request.bodyToMono(RunAgentParameters.class).flatMap(params -> {
            // request.principal() returns the authenticated principal if Spring Security is wired,
            // or Mono.empty() otherwise. The defaultIfEmpty branch gives Dojo-style anonymous
            // access without requiring auth configuration.
            Mono<String> userIdMono = request.principal()
                    .map(Principal::getName)
                    .defaultIfEmpty("anonymous-" + params.getThreadId());

            // Bridge Reactor Mono -> RxJava Single for the adapter's reactive API.
            Single<String> userIdSingle = Single.fromPublisher(userIdMono);

            Flowable<BaseEvent> flow = adapter.runAgent(params, userIdSingle);
            Flux<ServerSentEvent<String>> sse = RxJava3Adapter.flowableToFlux(flow)
                    .map(this::serializeAsSse);
            return ServerResponse.ok()
                    .contentType(MediaType.TEXT_EVENT_STREAM)
                    .body(sse, ServerSentEvent.class);
        });
    }

    private ServerSentEvent<String> serializeAsSse(BaseEvent event) {
        try {
            return ServerSentEvent.<String>builder()
                    .data(objectMapper.writeValueAsString(event))
                    .build();
        } catch (JsonProcessingException e) {
            logger.error("Error serializing event to JSON", e);
            return ServerSentEvent.<String>builder().comment("serialization error").build();
        }
    }
}
```

### 1.4. Adding Spring Security (optional)

The example above works without Spring Security — the handler falls back to an anonymous per-thread userId. To source the `userId` from an authenticated principal, add `spring-boot-starter-security` to your pom and configure a `SecurityWebFilterChain`. The same `request.principal()` call in the handler will then return the authenticated principal automatically.

#### Why resolve the principal in the handler (not inside the adapter)

`adk-java` deliberately keeps its public API on RxJava — it does not import Reactor types. The reason: Spring Security's `ReactiveSecurityContextHolder.getContext()` reads the principal from the Reactor `ContextView`, which only propagates through Reactor subscribers. A naive `Mono → Single` bridge inside the adapter would hand the upstream `Mono` an RxJava Subscriber with no `ContextView`, and the principal lookup would silently return empty.

The fix is structural: resolve the principal **inside the Reactor pipeline** (the WebFlux handler), then pass the resolved `String` across the Reactor→RxJava boundary via `Single.fromPublisher(mono)`. Safe because the value has already been materialized in the Reactor flow before the bridge.

#### Variant: resolve via ReactiveSecurityContextHolder explicitly

```java
import org.springframework.security.core.context.ReactiveSecurityContextHolder;
// ...
Mono<String> userIdMono = ReactiveSecurityContextHolder.getContext()
        .map(ctx -> ctx.getAuthentication().getName())
        .defaultIfEmpty("anonymous-" + params.getThreadId());
```

Identical behavior to `request.principal()` when Spring Security is configured — pick whichever is more readable in your codebase.

#### Minimal SecurityConfig

```java
package com.your.package.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.core.userdetails.MapReactiveUserDetailsService;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.web.server.SecurityWebFilterChain;

@Configuration
@EnableWebFluxSecurity
public class SecurityConfig {

    @Bean
    public SecurityWebFilterChain securityWebFilterChain(ServerHttpSecurity http) {
        return http
                .csrf(ServerHttpSecurity.CsrfSpec::disable)
                .authorizeExchange(ex -> ex
                        .pathMatchers("/chat").authenticated()
                        .anyExchange().permitAll())
                .httpBasic(Customizer.withDefaults())
                .build();
    }

    @Bean
    @SuppressWarnings("deprecation") // Demo only — replace with a real PasswordEncoder
    public MapReactiveUserDetailsService userDetailsService() {
        UserDetails demo = User.withDefaultPasswordEncoder()
                .username("demo")
                .password("demo")
                .roles("USER")
                .build();
        return new MapReactiveUserDetailsService(demo);
    }
}
```

#### Allowing unauthenticated requests (opt-in)

The adapter emits a single `RUN_ERROR` event (no `RUN_STARTED`, no session created) when the resolved `userId` is `null`, blank, empty, or errored. To let unauthenticated requests through with a fallback identity, add `.defaultIfEmpty(...)` to the principal `Mono` **before** the `zip`:

```java
Mono<String> userIdMono = ReactiveSecurityContextHolder.getContext()
        .map(ctx -> ctx.getAuthentication().getName())
        .defaultIfEmpty("anonymous");
```

**Caveat**: every unauthenticated caller will share the same `"anonymous"` session identity in the ADK store. Use a per-request derived fallback (e.g., a request-scoped UUID, or the `threadId`) if you need isolation.

#### Sync userId

When the userId is already known (no async lookup needed), wrap it in `Single.just(...)`:

```java
adapter.runAgent(params, Single.just("alice"));
```

The `Single` is subscribed lazily — only when the returned `Flowable` is subscribed (cold semantics). If the `Single` emits empty, errors, or yields a `null`/blank value, the adapter produces a single `RUN_ERROR` event and completes.

This structure provides a clear path from basic library usage to a clean, production-ready Spring Boot integration.

---

## 2. Core Concepts: Pure Java Usage

This section demonstrates how to use the core components of the AG-UI ADK in a plain Java context, without any web framework dependencies.

### Dependencies

Ensure you have the necessary dependencies for the ADK and an implementation for the ADK services (e.g., `google-adk-core`). You will also need `jackson-databind` for JSON serialization.

```xml
<dependency>
    <groupId>com.fasterxml.jackson.core</groupId>
    <artifactId>jackson-databind</artifactId>
    <version>2.13.3</version> <!-- Check for the latest version -->
</dependency>
```

### Example: Running the Agent

This class shows the fundamental setup and execution flow. The `userId` is now a per-call argument to `runAgent(...)` — no `userIdExtractor` to wire up.

**`AdkRunnerExample.java`**
```java
package com.your.package;

import com.agui.adk.AguiAdkRunnerAdapter;
import com.agui.adk.SessionManager;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.BaseEvent;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.agents.RunConfig;
import com.google.adk.artifacts.BaseArtifactService;
import com.google.adk.artifacts.InMemoryArtifactService;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.memory.InMemoryMemoryService;
import com.google.adk.runner.BaseAgent;
import com.google.adk.runner.Runner;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.InMemorySessionService;
import com.google.adk.util.ObjectMapperFactory;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.disposables.Disposable;

import java.io.IOException;
import java.time.Duration;
import java.util.UUID;

public class AdkRunnerExample {

    private final AguiAdkRunnerAdapter runnerAdapter;
    private final ObjectMapper objectMapper;

    public AdkRunnerExample() throws IOException {
        // 1. Initialize core services (using in-memory implementations for example)
        BaseArtifactService artifactService = new InMemoryArtifactService();
        BaseMemoryService memoryService = new InMemoryMemoryService();
        BaseSessionService sessionService = new InMemorySessionService();

        // 2. Create SessionManager
        SessionManager sessionManager = new SessionManager(
                sessionService,
                memoryService,
                Duration.ofMinutes(20), // Session timeout
                Duration.ofMinutes(5)   // Cleanup interval
        );

        // 3. Create Runner — replace null with a real BaseAgent in a real application
        BaseAgent assistantAgent = null;
        Runner runner = new Runner(
                assistantAgent,
                "appName",
                artifactService,
                sessionService,
                memoryService);

        // 4. Create RunConfig
        RunConfig runConfig = RunConfig.builder()
                .setStreamingMode(RunConfig.StreamingMode.SSE)
                .build();

        // 5. Create the AguiAdkRunnerAdapter (no userIdExtractor — userId is per-call)
        this.runnerAdapter = new AguiAdkRunnerAdapter(runner, sessionManager, runConfig);

        // 6. Initialize ObjectMapper for JSON serialization
        this.objectMapper = new ObjectMapper();
        ObjectMapperFactory.addMixins(this.objectMapper);
    }

    public Disposable runAndPrintEvents(RunAgentParameters params, String userId) {
        System.out.println("Starting agent run for thread: " + params.getThreadId() + " (user: " + userId + ")");

        // 7. Run the agent — userId is a per-call argument supplied as a Single<String>.
        //    For a known value, wrap with Single.just(...). For an async source (DB lookup,
        //    auth service call, etc.), pass the Single produced by that source.
        Flowable<BaseEvent> eventFlowable = runnerAdapter.runAgent(params, Single.just(userId));

        // 8. Subscribe to the stream to process and serialize events
        return eventFlowable.subscribe(
                event -> {
                    try {
                        String jsonEvent = objectMapper.writeValueAsString(event);
                        System.out.println("Received event: " + jsonEvent);
                    } catch (JsonProcessingException e) {
                        System.err.println("Error serializing event to JSON: " + e.getMessage());
                    }
                },
                error -> {
                    System.err.println("Error during agent run: " + error.getMessage());
                    error.printStackTrace();
                },
                () -> System.out.println("Agent run completed.")
        );
    }

    public static void main(String[] args) throws IOException {
        AdkRunnerExample example = new AdkRunnerExample();

        // Build your parameters as needed
        RunAgentParameters params = RunAgentParameters.builder()
                .threadId(UUID.randomUUID().toString())
                // .messages(...) // Add messages as needed
                .build();

        Disposable subscription = example.runAndPrintEvents(params, "alice");

        // In a real application, manage the subscription lifecycle properly.
        while (!subscription.isDisposed()) {
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }
}
```
