package com.example.agent.web;

import com.agui.adk.AguiAdkRunnerAdapter;
import com.agui.core.agent.RunAgentParameters;
import com.agui.server.spring.AgUiParameters;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.function.BiFunction;

@Component
public class ChatHandler {

    private final AguiAdkRunnerAdapter aguiAdkRunnerAdapter;
    private final BiFunction<AguiAdkRunnerAdapter, RunAgentParameters, Flux<ServerSentEvent<String>>> agentRunToSseFluxConverter;

    public ChatHandler(AguiAdkRunnerAdapter aguiAdkRunnerAdapter, BiFunction<AguiAdkRunnerAdapter, RunAgentParameters, Flux<ServerSentEvent<String>>> agentRunToSseFluxConverter) {
        this.aguiAdkRunnerAdapter = aguiAdkRunnerAdapter;
        this.agentRunToSseFluxConverter = agentRunToSseFluxConverter;
    }

    public Mono<ServerResponse> handleRun(ServerRequest request) {
        return request.bodyToMono(AgUiParameters.class)
                .map(this::buildRunAgentParameters)
                .flatMap(runAgentParameters -> {
                    Flux<ServerSentEvent<String>> sseFlux = agentRunToSseFluxConverter.apply(aguiAdkRunnerAdapter, runAgentParameters);
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
}
