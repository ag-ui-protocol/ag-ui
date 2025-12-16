package com.example.agent.configuration;

import com.agui.server.spring.AgUiService;
import com.agui.server.streamer.AgentStreamer;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;


@Configuration
public class AguiConfiguration {
    @Bean
    public AgentStreamer agentStreamer() {
        return new AgentStreamer();
    }

    @Bean
    public AgUiService agUiService(ObjectMapper objectMapper) {
        return new AgUiService(agentStreamer(), objectMapper);
    }

}
