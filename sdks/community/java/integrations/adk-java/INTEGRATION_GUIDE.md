# Integration Guide

This guide provides instructions and examples for integrating the AG-UI ADK into your applications.

## 1. Integrating with Spring WebFlux for Server-Sent Events (SSE)

This section provides a production-grade integration pattern for Spring Boot applications. We will use a stateless `BiFunction` bean to handle the conversion to a Server-Sent Events stream.

### 1.1. Add Dependencies

Add the necessary dependencies to your `pom.xml`.

**`pom.xml`**
```xml
<dependency>
    <groupId>io.projectreactor.addons</groupId>
    <artifactId>reactor-adapter</artifactId>
    <version>3.4.5</version> <!-- Check for the latest version -->
</dependency>
<dependency>
    <groupId>com.fasterxml.jackson.core</groupId>
    <artifactId>jackson-databind</artifactId>
    <version>2.13.3</version> <!-- Check for the latest version -->
</dependency>
```

### 1.2. Configure Beans in Spring

Define all the necessary ADK-related beans in a `@Configuration` class. These beans will directly provide the `AguiAdkRunnerAdapter` and the `BiFunction` for SSE transformation.

**`AdkConfiguration.java`**
```java
package com.your.package.config;

import com.agui.adk.AguiAdkRunnerAdapter;
import com.agui.adk.SessionManager;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.BaseEvent;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.agents.RunConfig;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.memory.InMemoryMemoryService;
import com.google.adk.runner.BaseAgent;
import com.google.adk.runner.Runner;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.InMemorySessionService;
import com.google.adk.artifacts.BaseArtifactService;
import com.google.adk.artifacts.InMemoryArtifactService;
import com.google.adk.util.ObjectMapperFactory;
import io.reactivex.rxjava3.core.Flowable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.http.codec.ServerSentEvent;
import reactor.adapter.rxjava.RxJava3Adapter;
import reactor.core.publisher.Flux;

import java.time.Duration;
import java.util.function.BiFunction;
import java.util.function.Function;

@Configuration
public class AdkConfiguration {

    private static final Logger logger = LoggerFactory.getLogger(AdkConfiguration.class);

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
    public AguiAdkRunnerAdapter aguiAdkRunnerAdapter(Runner runner, SessionManager sessionManager,
                                                     RunConfig runConfig, Function<RunAgentParameters, String> userIdExtractor) {
        return new AguiAdkRunnerAdapter(
                runner,
                sessionManager,
                runConfig,
                userIdExtractor
        );
    }

    @Bean @Primary
    public ObjectMapper objectMapper() {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectMapperFactory.addMixins(objectMapper);
        return objectMapper;
    }

    @Bean
    public Function<RunAgentParameters, String> userIdExtractor() {
        return params -> "anonymous-" + params.getThreadId();
    }

    @Bean
    public Runner runner(BaseAgent assistantAgent, BaseArtifactService artifactService, BaseSessionService sessionService,
                         BaseMemoryService memoryService) {
        return new Runner(
                assistantAgent,
                "appName",
                artifactService,
                sessionService,
                memoryService);
    }

    @Bean(destroyMethod = "shutdown") // This ensures graceful shutdown
    public SessionManager sessionManager(BaseSessionService sessionService, BaseMemoryService memoryService) {
        // The SessionManager is a singleton that manages all user sessions.
        return new SessionManager(
                sessionService,
                memoryService,
                Duration.ofMinutes(20), // Session timeout
                Duration.ofMinutes(5)   // Cleanup interval
        );
    }

    // Functional Bean for SSE conversion
    @Bean
    public BiFunction<AguiAdkRunnerAdapter, RunAgentParameters, Flux<ServerSentEvent<String>>> agentRunToSseFluxConverter(
            ObjectMapper objectMapper) {
        
        return (runnerAdapter, params) -> {
            Flowable<BaseEvent> eventFlowable = runnerAdapter.runAgent(params);
            Flux<BaseEvent> eventFlux = RxJava3Adapter.flowableToFlux(eventFlowable);

            return eventFlux.map(event -> {
                try {
                    String jsonEvent = objectMapper.writeValueAsString(event);
                    return ServerSentEvent.<String>builder().data(jsonEvent).build();
                } catch (JsonProcessingException e) {
                    logger.error("Error serializing event to JSON", e);
                    return ServerSentEvent.<String>builder().comment("serialization error").build();
                }
            }).doOnError(error -> logger.error("Error in the event stream for params: " + params, error));
        };
    }
}
```

### 1.3. Implement the Controller

Finally, inject the `AguiAdkRunnerAdapter` bean and the `BiFunction` bean into your controller to handle web requests cleanly.

**`ChatController.java`**
```java
package com.your.package.controller;

import com.agui.adk.AguiAdkRunnerAdapter;
import com.agui.core.agent.RunAgentParameters;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

import java.util.function.BiFunction;

@RestController
public class ChatController {

    private final AguiAdkRunnerAdapter runnerAdapter; // Assuming one primary adapter
    private final BiFunction<AguiAdkRunnerAdapter, RunAgentParameters, Flux<ServerSentEvent<String>>> agentRunToSseFluxConverter;

    @Autowired
    public ChatController(AguiAdkRunnerAdapter runnerAdapter,
                          BiFunction<AguiAdkRunnerAdapter, RunAgentParameters, Flux<ServerSentEvent<String>>> agentRunToSseFluxConverter) {
        this.runnerAdapter = runnerAdapter;
        this.agentRunToSseFluxConverter = agentRunToSseFluxConverter;
    }

    @PostMapping(value = "/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> handleRun(@RequestBody final RunAgentParameters parameters) {
        // The RunAgentParameters object is deserialized directly from the request body.
        // Apply the function with the adapter and params.
        return agentRunToSseFluxConverter.apply(runnerAdapter, parameters);
    }
}
```
This structure provides a clear path from basic library usage to a clean, production-ready Spring Boot integration.

---

## 2. Core Concepts: Pure Java Usage

This section demonstrates how to use the core components of the AG-UI ADK in a plain Java context, without any web framework dependencies. This serves as the foundational "how-to" for the library.

### Dependencies

Ensure you have the necessary dependencies for the ADK and an implementation for the ADK services (e.g., `google-adk-core`). You will also need `jackson-databind` for JSON serialization.

**`pom.xml`**
```xml
<dependency>
    <groupId>com.fasterxml.jackson.core</groupId>
    <artifactId>jackson-databind</artifactId>
    <version>2.13.3</version> <!-- Check for the latest version -->
</dependency>
```

### Example: Running the Agent

This class shows the fundamental setup and execution flow.

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
import com.google.adk.runner.Runner;
import com.google.adk.runner.BaseAgent;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.InMemorySessionService;
import com.google.adk.artifacts.BaseArtifactService;
import com.google.adk.artifacts.InMemoryArtifactService;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.memory.InMemoryMemoryService;
import com.google.adk.util.ObjectMapperFactory;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.disposables.Disposable;

import java.io.IOException;
import java.time.Duration;
import java.util.UUID;
import java.util.function.Function;

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
            Duration.ofMinutes(5)    // Cleanup interval
        );

        // 3. Create Runner
        // This requires a BaseAgent. In a real application, you'd get this from your
        // ADK instance (e.g., adk.agents().get("your-agent-name"))
        // For this example, we'll assume a null agent which would fail at runtime.
        // Replace null with a real BaseAgent instance.
        BaseAgent assistantAgent = null; 
        Runner runner = new Runner(
                assistantAgent,
                "appName", // You might want to make this dynamic
                artifactService,
                sessionService,
                memoryService);

        // 4. Create RunConfig
        RunConfig runConfig = RunConfig.builder()
                .setStreamingMode(RunConfig.StreamingMode.SSE)
                .build();

        // 5. Create userIdExtractor
        Function<RunAgentParameters, String> userIdExtractor = params -> "anonymous-" + params.getThreadId();
        
        // 6. Create the AguiAdkRunnerAdapter
        this.runnerAdapter = new AguiAdkRunnerAdapter(
            runner,
            sessionManager,
            runConfig,
            userIdExtractor
        );

        // 7. Initialize ObjectMapper for JSON serialization
        this.objectMapper = new ObjectMapper();
        ObjectMapperFactory.addMixins(this.objectMapper);
    }

    public Disposable runAndPrintEvents(RunAgentParameters params) {
        System.out.println("Starting agent run for thread: " + params.getThreadId());

        // 8. Run the agent and get the event stream
        Flowable<BaseEvent> eventFlowable = runnerAdapter.runAgent(params);

        // 9. Subscribe to the stream to process and serialize events
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
            () -> {
                System.out.println("Agent run completed.");
            }
        );
    }

    public static void main(String[] args) throws IOException {
        AdkRunnerExample example = new AdkRunnerExample();
        
        // Build your parameters as needed
        RunAgentParameters params = RunAgentParameters.builder()
            .threadId(UUID.randomUUID().toString())
            // .messages(...) // Add messages as needed
            .build();
            
        Disposable subscription = example.runAndPrintEvents(params);
        
        // In a real application, you would manage the lifecycle of the subscription.
        // For this example, we'll just wait for it to complete.
        while (!subscription.isDisposed()) {
            try {
                Thread.sleep(100); // Shorter sleep for responsiveness
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }
}
```