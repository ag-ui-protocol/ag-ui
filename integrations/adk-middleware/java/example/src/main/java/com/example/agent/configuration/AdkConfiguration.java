package com.example.agent.configuration;

import com.google.adk.agents.RunConfig;
import com.google.adk.artifacts.BaseArtifactService;
import com.google.adk.artifacts.InMemoryArtifactService;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.memory.InMemoryMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.InMemorySessionService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;


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

}
