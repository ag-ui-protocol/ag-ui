package com.example.agent.configuration;

import com.agui.adk.AguiAdkRunnerAdapter;
import com.agui.adk.SessionManager;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.BaseEvent;
import com.agui.json.ObjectMapperFactory;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jdk8.Jdk8Module;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.google.adk.agents.RunConfig;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.runner.Runner;
import com.google.adk.sessions.BaseSessionService;
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
public class AguiConfiguration {

    private static final Logger logger = LoggerFactory.getLogger(AguiConfiguration.class);


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
    public Function<RunAgentParameters, String> userIdExtractor() {
        return params -> "anonymous-" + params.getThreadId();
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

    @Bean
    public BiFunction<AguiAdkRunnerAdapter, RunAgentParameters, Flux<ServerSentEvent<String>>> agentRunToSseFluxConverter(
            ObjectMapper objectMapper) {

        return (runnerAdapter, params) -> {
            Flowable<BaseEvent> eventFlowable = runnerAdapter.runAgent(params);
            Flux<BaseEvent> eventFlux = RxJava3Adapter.flowableToFlux(eventFlowable);

            return eventFlux.map(event -> {
                try {
                    String jsonEvent = objectMapper.writeValueAsString(event);
                    return ServerSentEvent.<String>builder().data(" " + jsonEvent).build();
                } catch (JsonProcessingException e) {
                    logger.error("Error serializing event to JSON", e);
                    return ServerSentEvent.<String>builder().comment("serialization error").build();
                }
            }).doOnError(error -> logger.error("Error in the event stream for params: " + params, error));
        };
    }

}
