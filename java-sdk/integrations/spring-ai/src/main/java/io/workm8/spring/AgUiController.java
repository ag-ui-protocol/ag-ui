package io.workm8.spring;

import io.workm8.agui.client.RunAgentParameters;
import io.workm8.agui.client.subscriber.AgentSubscriber;
import io.workm8.agui.client.subscriber.AgentSubscriberParams;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.workm8.agui.event.BaseEvent;
import io.workm8.agui.state.State;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.ai.ollama.OllamaChatModel;
import org.springframework.ai.ollama.api.OllamaApi;
import org.springframework.ai.ollama.api.OllamaOptions;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

@RestController
public class AgUiController {

    @PostMapping(value = "/sse/{agentId}")
    public ResponseEntity<SseEmitter> streamData(@PathVariable("agentId") final String agentId, @RequestBody() final AgUiParameters agUiParameters) {
        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE);

        var chatModel = OllamaChatModel.builder()
            .defaultOptions(OllamaOptions.builder().model("llama3.2").build())
            .ollamaApi(OllamaApi.builder().baseUrl("http://localhost:11434").build())
            .build();

        SpringAgent agent = new SpringAgent(
            agentId,
            "description",
            Objects.nonNull(agUiParameters.getThreadId()) ? agUiParameters.getThreadId() : UUID.randomUUID().toString(),
            agUiParameters.getMessages().stream().map(m -> {
                if (Objects.isNull(m.getName())) {
                    m.setName("");
                }
                return m;
            }).toList(),
            chatModel,
            new State(),
            true
        );

        var parameters = RunAgentParameters.builder()
            .runId(UUID.randomUUID().toString())
            .context(agUiParameters.getContext())
            .forwardedProps(agUiParameters.getForwardedProps())
            .tools(agUiParameters.getTools())
            .build();

        var objectMapper = new ObjectMapper();

        agent.runAgent(parameters, new AgentSubscriber() {
            @Override
            public void onEvent(BaseEvent event) {
                try {
                    emitter.send(SseEmitter.event().data(" " + objectMapper.writeValueAsString(event)).build());
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            }
            @Override
            public void onRunFinalized(AgentSubscriberParams params) {
                emitter.complete();
            }
            @Override
            public void onRunFailed(AgentSubscriberParams params, Throwable throwable) {
                emitter.completeWithError(throwable);
            }
        });

        return ResponseEntity
            .ok()
            .cacheControl(CacheControl.noCache())
            .body(emitter);
    }

    @GetMapping(value = "/{agentId}", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseBodyEmitter streamData(
        @PathVariable("agentId") final String agentId,
        HttpServletResponse response
    ) {
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Connection", "keep-alive");
        response.setContentType("text/plain;charset=UTF-8");

        ResponseBodyEmitter emitter = new ResponseBodyEmitter();

        // Process data in a separate thread
        CompletableFuture.runAsync(() -> {
            try {
                for (int i = 0; i < 10; i++) {
                    emitter.send("Data chunk " + i + "\n");
                    Thread.sleep(1000); // Simulate processing delay
                }
                emitter.complete();
            } catch (Exception e) {
                emitter.completeWithError(e);
            }
        });

        return emitter;
    }

}
