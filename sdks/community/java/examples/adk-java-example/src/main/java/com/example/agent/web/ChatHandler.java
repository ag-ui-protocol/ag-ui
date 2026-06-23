package com.example.agent.web;

import com.agui.adk.AguiAdkRunnerAdapter;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.BaseEvent;
import com.agui.server.spring.AgUiParameters;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.adapter.rxjava.RxJava3Adapter;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.security.Principal;

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
        return request.bodyToMono(AgUiParameters.class)
                .map(this::buildRunAgentParameters)
                .flatMap(params -> {
                    // Resolve the userId reactively. request.principal() is a standard WebFlux
                    // method that does NOT require Spring Security on the classpath:
                    //   - if Spring Security is configured, returns the authenticated principal
                    //   - if not, returns Mono.empty() and we fall back to a per-thread anonymous id
                    //
                    // In a real reactive setup the Mono could come from any async source:
                    //   - ReactiveSecurityContextHolder.getContext().map(c -> c.getAuthentication().getName())
                    //   - webClient.get()...bodyToMono(String.class)  (auth service lookup)
                    //   - r2dbcRepo.findUserBy(...)
                    Mono<String> userIdMono = request.principal()
                            .map(Principal::getName)
                            .defaultIfEmpty("anonymous-" + params.getThreadId());

                    // Bridge Reactor Mono -> RxJava Single for the adapter's reactive API.
                    // Safe here: userIdMono is resolved on the Reactor side (read from the
                    // request's exchange, not from a ContextView), so no context is lost across
                    // the bridge.
                    Single<String> userIdSingle = Single.fromPublisher(userIdMono);

                    Flowable<BaseEvent> flow = aguiAdkRunnerAdapter.runAgent(params, userIdSingle);
                    Flux<ServerSentEvent<String>> sseFlux = RxJava3Adapter.flowableToFlux(flow)
                            .map(this::serializeAsSse);
                    return ServerResponse.ok()
                            .contentType(MediaType.TEXT_EVENT_STREAM)
                            .body(sseFlux, ServerSentEvent.class);
                });
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
