package com.example.agent.configuration;

import com.agui.adk.SessionManager;
import com.agui.core.agent.RunAgentParameters;
import com.google.adk.agents.BaseAgent;
import com.google.adk.agents.LlmAgent;
import com.google.adk.artifacts.BaseArtifactService;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.runner.Runner;
import com.google.adk.sessions.BaseSessionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;
import java.util.function.Function;

@Configuration
public class AgentConfiguration {

    private static final Logger logger = LoggerFactory.getLogger(AgentConfiguration.class);

    @Bean
    public BaseAgent AssistantAgent(@Value("${agent.model.name}") String modelName, @Value("${GOOGLE_API_KEY:}") String apiKey) {

        if (apiKey == null || apiKey.isEmpty()) {
            logger.warn("GOOGLE_API_KEY environment variable is not set.");
        } else {
            logger.info("GOOGLE_API_KEY is set.");
        }

        return LlmAgent.builder()
                .name("assistant")
                .model(modelName)
                .instruction(" You are a specialized Q&A assistant. Your primary function is to provide accurate and concise answers")
                .build();
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

    @Bean
    public Function<RunAgentParameters, String> userIdExtractor() {
        return params -> "anonymous-" + params.getThreadId();
    }
}