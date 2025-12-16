package com.example.agent.web;

import com.agui.adk.AguiAdkRunnerAdapter;
import com.agui.adk.SessionManager;
import com.agui.core.agent.AgentSubscriber;
import com.agui.core.agent.AgentSubscriberParams;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.BaseEvent;
import com.agui.server.spring.AgUiParameters;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.agents.RunConfig;
import com.google.adk.runner.Runner;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

import java.util.function.Function;

@RestController
@CrossOrigin(origins = "http://localhost:3000")
public class MyController {

    private static final Logger logger = LoggerFactory.getLogger(MyController.class);

    private final Runner runner;
    private final RunConfig runConfig;
    private final SessionManager sessionManager;
    private final ObjectMapper objectMapper; // For serializing events to JSON
    private final Function<RunAgentParameters, String> userIdExtractor;


    public MyController(Runner runner, RunConfig runConfig, SessionManager sessionManager,
                        ObjectMapper objectMapper, Function<RunAgentParameters, String> userIdExtractor) {
        this.runner = runner;
        this.runConfig = runConfig;
        this.sessionManager = sessionManager;
        this.objectMapper = objectMapper;
        this.userIdExtractor = userIdExtractor;
    }

    @PostMapping(value = "/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> handleRun(@RequestBody final AgUiParameters agUiParameters) {
        return Flux.create(sink -> {
            AguiAdkRunnerAdapter aguiAdkRunnerAdapter = new AguiAdkRunnerAdapter(runner, sessionManager, runConfig, userIdExtractor);

            AgentSubscriber subscriber = new AgentSubscriber() {
                @Override
                public void onEvent(BaseEvent event) {
                    try {
                        String jsonEvent = objectMapper.writeValueAsString(event);
                        sink.next(ServerSentEvent.builder(jsonEvent).build());
                    } catch (JsonProcessingException e) {
                        logger.error("Error serializing event to JSON", e);
                        // Optionally, you can signal an error to the client
                        // sink.error(e);
                    }
                }

                @Override
                public void onRunFinalized(AgentSubscriberParams params) {
                    logger.info("Agent run finalized. Completing stream.");
                    sink.complete();
                }

                @Override
                public void onRunFailed(AgentSubscriberParams params, Throwable throwable) {
                    logger.error("Agent run failed. Erroring stream.", throwable);
                    sink.error(throwable);
                }
            };

            // Assuming the runAgent method that takes a subscriber is on the adapter
            // This will start the agent run asynchronously
            RunAgentParameters agentParameters = RunAgentParameters.builder().threadId(agUiParameters.getThreadId()).runId(agUiParameters.getRunId()).messages(agUiParameters.getMessages()).tools(agUiParameters.getTools()).context(agUiParameters.getContext()).forwardedProps(agUiParameters.getForwardedProps()).state(agUiParameters.getState()).build();

            aguiAdkRunnerAdapter.runAgent(agentParameters, subscriber);

            // Handle client disconnection
            sink.onDispose(() -> logger.info("Client disconnected."));
        });
    }
}
