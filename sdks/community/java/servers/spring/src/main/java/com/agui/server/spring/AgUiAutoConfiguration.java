package com.agui.server.spring;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.json.ObjectMapperFactory;
import com.agui.server.streamer.AgentStreamer;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * Spring Boot auto-configuration for ag-ui server components.
 * <p>
 * This auto-configuration automatically registers ag-ui server beans when the
 * corresponding classes are on the classpath. It provides sensible defaults while
 * allowing users to override any bean by providing their own implementation.
 * <p>
 * The auto-configuration registers:
 * <ul>
 * <li>{@link AgentStreamer} - For converting agent execution to reactive streams</li>
 * <li>{@link AgUiService} - For executing agents and streaming events via SSE</li>
 * </ul>
 * <p>
 * All beans are conditional on missing user-defined beans, allowing full customization
 * when needed. The configuration requires Jackson ObjectMapper to be available in the
 * application context.
 * <p>
 * This auto-configuration is automatically discovered by Spring Boot when the
 * ag-ui-spring module is on the classpath and will be applied unless explicitly
 * excluded.
 * <p>
 * Example exclusion:
 * <pre>{@code
 * @SpringBootApplication(exclude = AgUiAutoConfiguration.class)
 * public class MyApplication {
 *     // Custom configuration
 * }
 * }</pre>
 *
 * @author Pascal Wilbrink
 */
@AutoConfiguration
@ConditionalOnClass({AgUiService.class, AgentStreamer.class})
public class AgUiAutoConfiguration {

    /**
     * Creates an AgentStreamer bean if none is already defined.
     * <p>
     * AgentStreamer is used to convert agent execution from the subscriber-based
     * callback model to a reactive EventStream model, enabling integration with
     * streaming frameworks and server-side event handling.
     *
     * @return a new AgentStreamer instance
     */
    @Bean
    @ConditionalOnMissingBean
    public AgentStreamer agentStreamer() {
        return new AgentStreamer();
    }

    /**
     * Creates an AgUiService bean if none is already defined.
     * <p>
     * AgUiService provides the core functionality for running agents in a Spring
     * web environment and streaming their events to web clients through HTTP
     * Server-Sent Events. It requires both an AgentStreamer and ObjectMapper
     * to function properly.
     * <p>
     * The ObjectMapper is automatically configured with ag-ui mixins for
     * proper event serialization within the service constructor.
     *
     * @param agentStreamer the AgentStreamer for converting agent execution to streams
     * @param objectMapper  the Jackson ObjectMapper for JSON serialization of events
     * @return a configured AgUiService instance
     */
    @Bean
    @ConditionalOnMissingBean
    public AgUiService agUiService(AgentStreamer agentStreamer, ObjectMapper objectMapper) {
        ObjectMapperFactory.addMixins(objectMapper);
        return new AgUiService(agentStreamer, objectMapper);
    }

    @Bean
    @ConditionalOnMissingBean
    public ObjectMapper objectMapper() {
        return new ObjectMapper();
    }
}