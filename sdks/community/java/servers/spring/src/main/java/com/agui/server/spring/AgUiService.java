package com.agui.server.spring;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.BaseEvent;
import com.agui.core.stream.EventStream;
import com.agui.json.ObjectMapperFactory;
import com.agui.server.LocalAgent;
import com.agui.server.streamer.AgentStreamer;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;

/**
 * Spring service for executing agents and streaming events via Server-Sent Events (SSE).
 * <p>
 * AgUiService provides the core functionality for running agents in a Spring web environment
 * and streaming their events to web clients through HTTP Server-Sent Events. This enables
 * real-time communication between agents and web frontends, allowing for responsive user
 * interfaces that can display agent progress, messages, and tool executions in real-time.
 * <p>
 * The service integrates several key components:
 * <ul>
 * <li><strong>AgentStreamer:</strong> Converts agent execution to reactive event streams</li>
 * <li><strong>ObjectMapper:</strong> Serializes events to JSON for web transmission</li>
 * <li><strong>SseEmitter:</strong> Spring's mechanism for streaming events to web clients</li>
 * <li><strong>LocalAgent:</strong> The agent implementation to execute</li>
 * </ul>
 * <p>
 * Key features:
 * <ul>
 * <li>Real-time event streaming via Server-Sent Events</li>
 * <li>Automatic JSON serialization with agui mixins</li>
 * <li>Long-lived connections for streaming agent execution</li>
 * <li>Seamless integration with Spring web controllers</li>
 * <li>Error handling and completion signaling</li>
 * </ul>
 * <p>
 * The service is designed to be used as a Spring bean and injected into controllers
 * that need to execute agents and stream results to web clients. It handles all the
 * complexity of converting agent events to JSON and streaming them via SSE.
 * <p>
 * Example usage in a Spring controller:
 * <pre>{@code
 * @RestController
 * public class AgentController {
 *     @Autowired
 *     private AgUiService agUiService;
 *     
 *     @Autowired
 *     private MyAgent myAgent;
 *
 *     @PostMapping("/agents/run")
 *     public SseEmitter runAgent(@RequestBody AgUiParameters params) {
 *         return agUiService.runAgent(myAgent, params);
 *     }
 * }
 * }</pre>
 *
 * @author Pascal Wilbrink
 */
public class AgUiService {

    private final AgentStreamer agentStreamer;

    private final ObjectMapper objectMapper;

    /**
     * Constructs a new AgUiService with the specified dependencies.
     * <p>
     * This constructor initializes the service with an AgentStreamer for converting
     * agent execution to reactive streams and an ObjectMapper for JSON serialization.
     * The ObjectMapper is automatically configured with agui mixins to ensure
     * proper serialization of event objects.
     *
     * @param agentStreamer the AgentStreamer for converting agent execution to event streams
     * @param objectMapper  the Jackson ObjectMapper for JSON serialization of events
     */
    public AgUiService(
        final AgentStreamer agentStreamer,
        final ObjectMapper objectMapper
    ) {
        this.agentStreamer = agentStreamer;

        this.objectMapper = objectMapper;
        ObjectMapperFactory.addMixins(this.objectMapper);
    }

    /**
     * Executes the specified agent and returns an SseEmitter for streaming events to a web client.
     * <p>
     * This method orchestrates the complete agent execution workflow for web environments:
     * <ol>
     * <li>Converts AgUiParameters to RunAgentParameters for agent execution</li>
     * <li>Configures the agent with the provided thread ID and parameters</li>
     * <li>Creates an SseEmitter with unlimited timeout for long-lived streaming</li>
     * <li>Sets up an EventStream that serializes events to JSON and sends them via SSE</li>
     * <li>Initiates agent execution through the AgentStreamer</li>
     * <li>Returns the SseEmitter for immediate client connection</li>
     * </ol>
     * <p>
     * The returned SseEmitter is configured for long-lived connections and will:
     * <ul>
     * <li>Stream all agent events as JSON data to the connected client</li>
     * <li>Complete the stream when the agent finishes successfully</li>
     * <li>Complete with error if the agent encounters an exception</li>
     * <li>Handle I/O errors gracefully by converting them to runtime exceptions</li>
     * </ul>
     * <p>
     * The agent execution happens asynchronously, so this method returns immediately
     * with an SseEmitter that the client can connect to for receiving real-time updates.
     * <p>
     * <strong>Note:</strong> Each SSE data packet is prefixed with a space character to ensure
     * proper parsing by client libraries that might have issues with certain JSON structures.
     *
     * @param agent           the LocalAgent instance to execute
     * @param agUiParameters  the parameters containing conversation context, tools, and configuration
     * @return an SseEmitter configured for streaming agent events as JSON to web clients
     * @throws RuntimeException if JSON serialization fails during event streaming
     */
    public SseEmitter runAgent(final LocalAgent agent, final AgUiParameters agUiParameters) {
        var parameters = RunAgentParameters.builder()
            .threadId(agUiParameters.getThreadId())
            .runId(agUiParameters.getRunId())
            .messages(agUiParameters.getMessages())
            .tools(agUiParameters.getTools())
            .context(agUiParameters.getContext())
            .forwardedProps(agUiParameters.getForwardedProps())
            .state(agUiParameters.getState())
            .build();

        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE);

        var eventStream = new EventStream<BaseEvent>(
            event -> {
                try {
                    emitter.send(SseEmitter.event().data(" " + objectMapper.writeValueAsString(event)).build());
                } catch (IOException e) {
                    emitter.completeWithError(e);
                }
            },
            emitter::completeWithError,
            emitter::complete
        );

        this.agentStreamer.streamEvents(agent, parameters, eventStream);

        return emitter;
    }
}
