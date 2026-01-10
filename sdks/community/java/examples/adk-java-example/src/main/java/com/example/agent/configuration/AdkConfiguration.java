package com.example.agent.configuration;

import com.google.adk.agents.BaseAgent;
import com.google.adk.agents.LlmAgent;
import com.google.adk.agents.RunConfig;
import com.google.adk.artifacts.BaseArtifactService;
import com.google.adk.artifacts.InMemoryArtifactService;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.memory.InMemoryMemoryService;
import com.google.adk.runner.Runner;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.InMemorySessionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;


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
    public Runner runner(BaseAgent assistantAgent, BaseArtifactService artifactService, BaseSessionService sessionService,
                         BaseMemoryService memoryService) {
        return new Runner(
                assistantAgent,
                "appName",
                artifactService,
                sessionService,
                memoryService);
    }

    @Bean
    public BaseAgent AssistantAgent(@Value("${agent.model.name}") String modelName, @Value("google.gemini.api-key") String apiKey) {

        if (apiKey == null || apiKey.isEmpty()) {
            logger.warn("GOOGLE_API_KEY environment variable is not set.");
        } else {
            logger.info("GOOGLE_API_KEY is set.");
        }

        return LlmAgent.builder()
                .name("assistant")
                .model(modelName)
                .instruction(" You are a specialized assistant. Your primary function is to provide accurate and concise answers")
                .build();
    }

}
