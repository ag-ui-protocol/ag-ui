package com.example.agent.configuration;

import com.agui.adk.AguiAdkRunnerAdapter;
import com.agui.adk.SessionManager;
import com.agui.json.ObjectMapperFactory;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jdk8.Jdk8Module;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.google.adk.agents.RunConfig;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.runner.Runner;
import com.google.adk.sessions.BaseSessionService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;


@Configuration
public class AguiConfiguration {

    @Bean
    public ObjectMapper objectMapper() {
        ObjectMapper mapper = new ObjectMapper();
        mapper.registerModule(new Jdk8Module());
        mapper.registerModule(new JavaTimeModule());
        // Apply AG-UI specific mixins for polymorphic types (like the 'messages' array)
        ObjectMapperFactory.addMixins(mapper);
        return mapper;
    }

    @Bean
    public SessionManager sessionManager(BaseSessionService sessionService, BaseMemoryService memoryService) {
        // The SessionManager is a singleton that manages all user sessions.
        return new SessionManager(sessionService, memoryService);
    }

    @Bean
    public AguiAdkRunnerAdapter aguiAdkRunnerAdapter(Runner runner,
                                                     SessionManager sessionManager,
                                                     RunConfig runConfig) {
        return new AguiAdkRunnerAdapter(runner, sessionManager, runConfig);
    }
}
