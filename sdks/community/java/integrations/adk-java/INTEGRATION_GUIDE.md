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
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-security</artifactId>
</dependency>
<dependency>
    <groupId>io.projectreactor.addons</groupId>
    <artifactId>reactor-adapter</artifactId>
</dependency>
```

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

Inject the `AguiAdkRunnerAdapter` and the `ObjectMapper`. The handler composes `request.bodyToMono(...)` with `ReactiveSecurityContextHolder.getContext().map(...)` via `Mono.zip(...)`, then invokes `adapter.runAgent(params, userId)` with the resolved principal.

**`ChatHandler.java`**
```java
package com.your.package.web;

import com.agui.adk.AguiAdkRunnerAdapter;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.BaseEvent;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.reactivex.rxjava3.core.Flowable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.security.core.context.ReactiveSecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.adapter.rxjava.RxJava3Adapter;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

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
        Mono<RunAgentParameters> paramsMono = request.bodyToMono(RunAgentParameters.class);
        Mono<String> userIdMono = ReactiveSecurityContextHolder.getContext()
                .map(ctx -> ctx.getAuthentication().getName());

        return Mono.zip(paramsMono, userIdMono).flatMap(tuple -> {
            RunAgentParameters params = tuple.getT1();
            String userId = tuple.getT2();
            Flowable<BaseEvent> flow = adapter.runAgent(params, userId);
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

### 1.4. Wiring Spring Security's reactive principal

`adk-java` deliberately keeps its public API on RxJava — it does not import Reactor types. The reason: Spring Security's `ReactiveSecurityContextHolder.getContext()` reads the principal from the Reactor `ContextView`, which only propagates through Reactor subscribers. A naive `Mono → Single` bridge inside the adapter would hand the upstream `Mono` an RxJava Subscriber with no `ContextView`, and the principal lookup would silently return empty.

The fix is structural: resolve the principal **inside the Reactor pipeline** (the WebFlux handler), then pass the resolved `String` across the Reactor→RxJava boundary. The `Mono.zip(...)` pattern in § 1.3 is the canonical shape.

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

#### Reactive userId via the `Single<String>` overload

If your principal source is naturally typed as something other than `Mono<String>` and you can bridge it to RxJava `Single<String>` **without losing the upstream context**, use the second overload:

```java
Single<String> userId = ...; // e.g. Single.fromCallable(...) for a synchronous source
adapter.runAgent(params, userId);
```

The `Single` is subscribed only when the returned `Flowable` is subscribed (cold semantics). If the `Single` emits empty or errors, `RUN_ERROR` is the result — same contract as the `String` overload.

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

        // 7. Run the agent — userId is an explicit argument
        Flowable<BaseEvent> eventFlowable = runnerAdapter.runAgent(params, userId);

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
