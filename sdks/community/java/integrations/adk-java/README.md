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

## Spring Boot Integration

This section outlines how to integrate the `adk-java` library components into a Spring Boot application following the revised architectural design. The `adk-java` library now provides highly decoupled components, allowing the application to define its own strategy for managing `Runner` and `AguiAdkRunnerAdapter` instances.

### Core Components and Responsibilities

-   **`Runner` (from `adk-java`):** Represents the core logic for running an ADK agent for a specific application. It now includes its `appName` as part of its state.
-   **`AguiAdkRunnerAdapter` (from `adk-java`):** Is now designed to work with a *single, dedicated `Runner` instance*. An adapter instance is implicitly tied to one `appName` via its injected `Runner`. It is also configured with a `userIdExtractor` to determine the user for each request.
-   **`AguiAdkRunnerAdapterFactory` (Application-Defined):** Since the `AguiAdkRunnerAdapter` is no longer a singleton for all apps, the application must provide a factory to create and manage instances of `AguiAdkRunnerAdapter` (one per appName). This factory will typically implement caching and lazy-loading for `AguiAdkRunnerAdapter` instances, similar to how `DefaultRunnerFactory` managed `Runner` instances in our previous discussions.

### 1. Define Beans in a `@Configuration` Class

The application's Spring configuration (`AgentConfiguration`) will now define beans for the base services and for an `AguiAdkRunnerAdapterFactory` (which you will implement in your application).

It is crucial to manage the lifecycle of the `SessionManager` to ensure graceful shutdown and prevent resource leaks. By specifying `destroyMethod = "shutdown"`, you instruct Spring to automatically call the `shutdown()` method on the `SessionManager` bean when the application is closing.

```java
import com.agui.adk.BaseAgent;
import com.agui.adk.BaseArtifactService;
import com.agui.adk.BaseMemoryService;
import com.agui.adk.BaseSessionService;
import com.agui.adk.SessionManager;
import com.agui.adk.AguiAdkRunnerAdapter; // Imported for factory
import com.agui.core.agent.RunAgentParameters;
import com.google.adk.agents.RunConfig;
import com.google.adk.runner.Runner; // Imported for factory
import com.google.adk.agents.llm.LlmAgent;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component; // For AguiAdkRunnerAdapterFactory

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;


@Configuration
public class AgentConfiguration {

    @Bean
    public BaseAgent adkAgent() {
        return LlmAgent.builder()
                .name("my-spring-boot-agent")
                .model("gemini-2.5-flash")
                .instruction("You are a helpful assistant.")
                .build();
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

    @Bean
    public RunConfig runConfig() {
        return new RunConfig.Builder().setStreamingMode(StreamingMode.STREAMING).build();
    }

    // The userIdExtractor is still needed by each AguiAdkRunnerAdapter instance.
    @Bean
    public Function<RunAgentParameters, String> userIdExtractor() {
        return params -> {
            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            if (authentication != null && authentication.isAuthenticated()) {
                return authentication.getName();
            }
            return "anonymous-" + params.getThreadId();
        };
    }

    // --- Application-defined factory for AguiAdkRunnerAdapter instances ---
    // You will need to implement this in your application project.
    // This factory creates and manages AguiAdkRunnerAdapter instances, one per appName.
    // It will typically handle caching and lazy-loading.
    @Bean
    public AguiAdkRunnerAdapterFactory aguiAdkRunnerAdapterFactory(
            BaseAgent adkAgent,
            BaseArtifactService artifactService,
            BaseSessionService sessionService,
            BaseMemoryService memoryService,
            SessionManager sessionManager,
            RunConfig runConfig,
            Function<RunAgentParameters, String> userIdExtractor,
            YourAppNameRepository appNameRepository // To load persisted appNames
    ) {
        return new DefaultAguiAdkRunnerAdapterFactory(adkAgent, artifactService, sessionService, memoryService, sessionManager, runConfig, userIdExtractor, appNameRepository);
    }
}

// --- Application-defined AguiAdkRunnerAdapterFactory Interface ---
// This interface would reside in your application project or a shared module.
interface AguiAdkRunnerAdapterFactory {
    AguiAdkRunnerAdapter getAdapter(String appName);
}

// --- Example of Application-defined AguiAdkRunnerAdapterFactory Implementation ---
// This class would reside in your application project.
@Component
class DefaultAguiAdkRunnerAdapterFactory implements AguiAdkRunnerAdapterFactory {

    private final Map<String, AguiAdkRunnerAdapter> adapters = new ConcurrentHashMap<>();
    private final AguiAdkRunnerAdapter defaultAdapter;

    // Dependencies needed to create an AguiAdkRunnerAdapter
    private final BaseAgent adkAgent;
    private final BaseArtifactService artifactService;
    private final BaseSessionService sessionService;
    private final BaseMemoryService memoryService;
    private final SessionManager sessionManager;
    private final RunConfig runConfig;
    private final Function<RunAgentParameters, String> userIdExtractor;
    private final YourAppNameRepository appNameRepository;


    public DefaultAguiAdkRunnerAdapterFactory(
            BaseAgent adkAgent,
            BaseArtifactService artifactService,
            BaseSessionService sessionService,
            BaseMemoryService memoryService,
            SessionManager sessionManager,
            RunConfig runConfig,
            Function<RunAgentParameters, String> userIdExtractor,
            YourAppNameRepository appNameRepository
    ) {
        this.adkAgent = adkAgent;
        this.artifactService = artifactService;
        this.sessionService = sessionService;
        this.memoryService = memoryService;
        this.sessionManager = sessionManager;
        this.runConfig = runConfig;
        this.userIdExtractor = userIdExtractor;
        this.appNameRepository = appNameRepository;

        // Initialize the default Runner and Adapter
        Runner defaultRunner = createRunner("default-app");
        this.defaultAdapter = createAdapter(defaultRunner);
        this.adapters.put("default-app", this.defaultAdapter);
    }

    @Override
    public AguiAdkRunnerAdapter getAdapter(String appName) {
        AguiAdkRunnerAdapter adapter = adapters.get(appName);
        if (adapter != null) {
            return adapter; // Cache hit
        }

        synchronized (this.adapters) {
            adapter = adapters.get(appName);
            if (adapter != null) {
                return adapter; // Double-check after lock
            }

            // Check database for appName validity
            if (appNameRepository.existsByAppName(appName)) {
                Runner newRunner = createRunner(appName);
                AguiAdkRunnerAdapter newAdapter = createAdapter(newRunner);
                adapters.put(appName, newAdapter);
                return newAdapter;
            }
        }
        return this.defaultAdapter; // Return default if not found
    }

    private Runner createRunner(String appName) {
        // Here you would create the specific Runner instance
        // You might use some specific agent based on appName or a generic one.
        // For simplicity, using LlmAgent as an example:
        return LlmAgent.builder() // This needs BaseAgent dependency if not directly injected
                .name(appName + "-agent")
                .model("gemini-2.5-flash")
                .instruction("You are a helpful assistant for " + appName + ".")
                .build();
    }

    private AguiAdkRunnerAdapter createAdapter(Runner runner) {
        // Handle AGUIException from AguiAdkRunnerAdapter constructor
        return new AguiAdkRunnerAdapter(
                runner,
                this.sessionManager,
                this.runConfig,
                this.userIdExtractor
            );
    }
}
```

### 2. Use the Agent in a Controller

Now your controller will inject the `AguiAdkRunnerAdapterFactory` and use it to obtain the correct adapter instance for each request.

```java
import com.agui.adk.AguiAdkRunnerAdapter;
import com.agui.core.agent.RunAgentParameters;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader; // For appName if not in params
import org.springframework.web.bind.annotation.RestController;
import com.agui.core.agent.AgentSubscriber;

@RestController
public class AgentController {

    private final AguiAdkRunnerAdapterFactory adapterFactory;

    public AgentController(AguiAdkRunnerAdapterFactory adapterFactory) {
        this.adapterFactory = adapterFactory;
    }

    @PostMapping("/run-agent")
    public void runAgent(@RequestBody RunAgentParameters params, @RequestHeader(value = "X-App-Name", required = false) String appNameHeader) {
        // Example: Get appName from a request header, or from RunAgentParameters context
        String appNameToUse = appNameHeader != null ? appNameHeader : "default-app"; 

        AguiAdkRunnerAdapter agent = adapterFactory.getAdapter(appNameToUse);
        AgentSubscriber subscriber = createMySubscriber(); // Your subscriber implementation
        agent.runAgent(params, subscriber);
    }

    private AgentSubscriber createMySubscriber() {
        // Replace with your actual subscriber implementation
        return new AgentSubscriber();
    }
}
```

### Role of the `SessionManager`
```java
The `SessionManager` is part of this integration library (and not the core Google ADK) to provide essential, production-ready features for a server environment out-of-the-box. The core ADK provides a low-level, unopinionated `SessionService` for basic data storage. Our `SessionManager` adds a higher-level management layer on top, handling timeouts, automatic cleanup, and integration with the `MemoryService`. This separation keeps the core ADK simple and flexible, while our library provides the robust features needed for a web application.
```
The `SessionManager` is part of this integration library (and not the core Google ADK) to provide essential, production-ready features for a server environment out-of-the-box. The core ADK provides a low-level, unopinionated `SessionService` for basic data storage. Our `SessionManager` adds a higher-level management layer on top, handling timeouts, automatic cleanup, and integration with the `MemoryService`. This separation keeps the core ADK simple and flexible, while our library provides the robust features needed for a web application.

For more details on the architecture of this integration, see [ARCHITECTURE.md](./ARCHITECTURE.md).