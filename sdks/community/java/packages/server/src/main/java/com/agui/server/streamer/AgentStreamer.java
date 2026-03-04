package com.agui.server.streamer;

import com.agui.core.agent.Agent;
import com.agui.core.agent.AgentSubscriber;
import com.agui.core.agent.AgentSubscriberParams;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.BaseEvent;
import com.agui.core.stream.EventStream;

/**
 * Utility class that bridges agent execution with reactive event streaming.
 * <p>
 * AgentStreamer provides a convenient way to convert agent execution from the
 * subscriber-based callback model to a reactive EventStream model. This is
 * particularly useful in server-side scenarios where agent events need to be
 * streamed to clients via HTTP Server-Sent Events, WebSockets, or other
 * streaming protocols.
 * <p>
 * The streamer acts as an adapter, subscribing to agent events through the
 * AgentSubscriber interface and forwarding them to an EventStream for reactive
 * consumption. This enables functional programming patterns and easier integration
 * with streaming frameworks.
 * <p>
 * Key features:
 * <ul>
 * <li>Converts callback-based agent execution to reactive streams</li>
 * <li>Handles agent lifecycle events (completion, errors)</li>
 * <li>Provides clean separation between agent logic and streaming concerns</li>
 * <li>Enables integration with web streaming technologies</li>
 * </ul>
 * <p>
 * Example usage:
 * <pre>{@code
 * AgentStreamer streamer = new AgentStreamer();
 * EventStream<BaseEvent> eventStream = new EventStream<>();
 *
 * streamer.streamEvents(agent, parameters, eventStream);
 *
 * // Subscribe to the stream
 * eventStream.subscribe(
 *     event -> handleEvent(event),
 *     error -> handleError(error),
 *     () -> handleComplete()
 * );
 * }</pre>
 *
 * @author Pascal Wilbrink
 */
public class AgentStreamer {

    /**
     * Executes an agent and streams all events to the provided EventStream.
     * <p>
     * This method creates an internal AgentSubscriber that captures all agent
     * events and forwards them to the provided EventStream. The agent execution
     * is initiated asynchronously, and the EventStream will receive:
     * <ul>
     * <li>All BaseEvent objects as they are emitted during agent execution</li>
     * <li>Completion signal when the agent run finishes successfully</li>
     * <li>Error signal if the agent run fails or encounters an exception</li>
     * </ul>
     * <p>
     * The EventStream follows reactive semantics, meaning subscribers can
     * process events asynchronously and apply functional transformations
     * such as filtering, mapping, or buffering.
     * <p>
     * The method returns immediately after initiating the agent execution.
     * The actual agent processing happens asynchronously, with events being
     * streamed to the EventStream as they occur.
     *
     * @param agent       the agent instance to execute
     * @param parameters  the configuration parameters for agent execution,
     *                   including context, tools, and other execution settings
     * @param eventStream the EventStream that will receive all agent events,
     *                   completion signals, and error signals
     * @throws IllegalArgumentException if any parameter is null
     * @throws IllegalStateException if the agent is not in a valid state for execution
     */
    public void streamEvents(final Agent agent, final RunAgentParameters parameters, final EventStream<BaseEvent> eventStream) {
        agent.runAgent(parameters, new AgentSubscriber() {
            @Override
            public void onEvent(BaseEvent event) {
                eventStream.next(event);
            }
            @Override
            public void onRunFinalized(AgentSubscriberParams params) {
                eventStream.complete();
            }
            @Override
            public void onRunFailed(AgentSubscriberParams params, Throwable throwable) {
                eventStream.error(throwable);
            }
        });
    }
}