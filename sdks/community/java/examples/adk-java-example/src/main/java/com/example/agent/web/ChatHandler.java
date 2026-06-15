package com.example.agent.web;

import com.agui.adk.AguiAdkRunnerAdapter;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.BaseEvent;
import com.agui.server.spring.AgUiParameters;
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

    private final AguiAdkRunnerAdapter aguiAdkRunnerAdapter;
    private final ObjectMapper objectMapper;

    public ChatHandler(AguiAdkRunnerAdapter aguiAdkRunnerAdapter, ObjectMapper objectMapper) {
        this.aguiAdkRunnerAdapter = aguiAdkRunnerAdapter;
        this.objectMapper = objectMapper;
    }

    public Mono<ServerResponse> handleRun(ServerRequest request) {
        Mono<RunAgentParameters> paramsMono = request.bodyToMono(AgUiParameters.class)
                .map(this::buildRunAgentParameters);

        return Mono.zip(paramsMono, resolvePrincipal())
                .flatMap(tuple -> {
                    RunAgentParameters params = tuple.getT1();
                    String userId = tuple.getT2();
                    Flowable<BaseEvent> flow = aguiAdkRunnerAdapter.runAgent(params, userId);
                    Flux<ServerSentEvent<String>> sseFlux = RxJava3Adapter.flowableToFlux(flow)
                            .map(this::serializeAsSse);
                    return ServerResponse.ok()
                            .contentType(MediaType.TEXT_EVENT_STREAM)
                            .body(sseFlux, ServerSentEvent.class);
                });
    }

    // Resolves the authenticated principal from the Reactor ContextView. Stays on the
    // Reactor side so ReactiveSecurityContextHolder sees the request's SecurityContext.
    // Callers who want to allow unauthenticated access should add .defaultIfEmpty(...)
    // before passing the value to runAgent; otherwise the adapter emits RUN_ERROR.
    private Mono<String> resolvePrincipal() {
        return ReactiveSecurityContextHolder.getContext()
                .map(ctx -> ctx.getAuthentication().getName());
    }

    private RunAgentParameters buildRunAgentParameters(AgUiParameters parameters) {
        return RunAgentParameters.builder()
                .threadId(parameters.getThreadId())
                .runId(parameters.getRunId())
                .messages(parameters.getMessages())
                .tools(parameters.getTools())
                .context(parameters.getContext())
                .forwardedProps(parameters.getForwardedProps())
                .state(parameters.getState())
                .build();
    }

    private ServerSentEvent<String> serializeAsSse(BaseEvent event) {
        try {
            String json = objectMapper.writeValueAsString(event);
            return ServerSentEvent.<String>builder().data(json).build();
        } catch (JsonProcessingException e) {
            logger.error("Error serializing event to JSON", e);
            return ServerSentEvent.<String>builder().comment("serialization error").build();
        }
    }
}
