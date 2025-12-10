package com.agui.http;

import com.agui.client.agent.AbstractAgent;
import com.agui.core.agent.RunAgentInput;
import com.agui.core.event.BaseEvent;
import com.agui.core.message.BaseMessage;
import com.agui.core.state.State;
import com.agui.core.stream.IEventStream;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * HTTP-based agent implementation that delegates execution to remote services via HTTP clients.
 * <p>
 * HttpAgent extends AbstractAgent to provide agent execution capabilities through HTTP
 * communication. It acts as a bridge between the local agent framework and remote AI services,
 * handling HTTP request/response cycles, event streaming, and connection management.
 * <p>
 * Key features:
 * <ul>
 * <li>Asynchronous HTTP communication with remote agent services</li>
 * <li>Real-time event streaming from remote agent execution</li>
 * <li>Cancellation support for long-running operations</li>
 * <li>Resource management with proper HTTP client cleanup</li>
 * <li>Builder pattern for flexible configuration</li>
 * </ul>
 * <p>
 * The agent requires an HttpClient implementation to handle the actual HTTP communication.
 * Different HttpClient implementations can be used to support various protocols, authentication
 * methods, and service providers.
 * <p>
 * Example usage:
 * <pre>{@code
 * HttpAgent agent = HttpAgent.builder()
 *     .agentId("my-agent")
 *     .threadId("conversation-123")
 *     .httpClient(myHttpClient)
 *     .debug(true)
 *     .build();
 * }</pre>
 *
 * @author Pascal Wilbrink
 */
public class HttpAgent extends AbstractAgent {

    protected final BaseHttpClient httpClient;

    /**
     * Private constructor used by the Builder to create HttpAgent instances.
     * <p>
     * This constructor is private to enforce the use of the Builder pattern,
     * ensuring proper validation and configuration of all required parameters.
     *
     * @param agentId         unique identifier for this agent instance
     * @param description     human-readable description of the agent's purpose
     * @param threadId        identifier for the conversation thread
     * @param httpClient      the HTTP client implementation for remote communication
     * @param initialMessages initial conversation history
     * @param state           initial agent state
     * @param debug           whether to enable debug logging
     */
    private HttpAgent(
        final String agentId,
        final String description,
        final String threadId,
        final BaseHttpClient httpClient,
        final List<BaseMessage> initialMessages,
        final State state,
        final boolean debug
    ) {
        super(agentId, description, threadId, initialMessages, state, debug);

        this.httpClient = httpClient;
    }

    public List<BaseMessage> getMessages() {
        return this.messages;
    }

    /**
     * Executes the agent by delegating to the HTTP client for remote processing.
     * <p>
     * This method implements the abstract run method from AbstractAgent by:
     * <ul>
     * <li>Creating a cancellation token for operation control</li>
     * <li>Initiating HTTP streaming with the remote service</li>
     * <li>Forwarding received events to the local event stream</li>
     * <li>Handling completion and error scenarios</li>
     * </ul>
     * <p>
     * The execution respects the event stream's cancellation state and ensures
     * proper propagation of events, errors, and completion signals.
     *
     * @param input  the input parameters to send to the remote agent service
     * @param stream the local event stream for forwarding received events
     */
    @Override
    protected void run(RunAgentInput input, IEventStream<BaseEvent> stream) {
        AtomicBoolean cancellationToken = new AtomicBoolean(false);

        CompletableFuture<Void> httpFuture = httpClient.streamEvents(
                input,
                event -> {
                    if (!stream.isCancelled()) {
                        stream.next(event);
                    }
                },
                cancellationToken
        );

        httpFuture.whenComplete((result, error) -> {
            if (error != null) {
                stream.error(error);
            } else {
                stream.complete();
            }
        });
    }

    /**
     * Closes the underlying HTTP client and releases associated resources.
     * <p>
     * This method should be called when the HttpAgent is no longer needed to ensure
     * proper cleanup of HTTP connections, thread pools, and other system resources.
     * <p>
     * After calling this method, the agent should not be used for further operations.
     */
    public void close() {
        if (httpClient != null) {
            httpClient.close();
        }
    }

    /**
     * Builder class for constructing HttpAgent instances with fluent configuration.
     * <p>
     * The Builder pattern ensures proper validation of required parameters and
     * provides a clean, readable API for agent configuration. All required
     * parameters are validated before agent construction.
     * <p>
     * Required parameters: agentId, threadId, httpClient
     * <p>
     * Optional parameters: description, messages, state, debug
     */
    public static class Builder {
        private String agentId;
        private String description = "";
        private String threadId;
        private BaseHttpClient httpClient;
        private List<BaseMessage> messages = new ArrayList<>();
        private State state = new State();
        private boolean debug = false;

        /**
         * Sets the unique agent identifier.
         *
         * @param agentId the unique identifier for this agent instance (required)
         * @return this builder instance for method chaining
         */
        public Builder agentId(String agentId) {
            this.agentId = agentId;
            return this;
        }

        /**
         * Sets the agent description.
         *
         * @param description human-readable description of the agent's purpose
         * @return this builder instance for method chaining
         */
        public Builder description(String description) {
            this.description = description;
            return this;
        }

        /**
         * Sets the conversation thread identifier.
         *
         * @param threadId the identifier for the conversation thread (required)
         * @return this builder instance for method chaining
         */
        public Builder threadId(String threadId) {
            this.threadId = threadId;
            return this;
        }

        /**
         * Sets the HTTP client for remote communication.
         *
         * @param httpClient the HTTP client implementation (required)
         * @return this builder instance for method chaining
         */
        public Builder httpClient(BaseHttpClient httpClient) {
            this.httpClient = httpClient;
            return this;
        }

        /**
         * Sets the initial conversation messages.
         *
         * @param messages the list of initial messages, or null for empty history
         * @return this builder instance for method chaining
         */
        public Builder messages(List<BaseMessage> messages) {
            this.messages = messages != null ? messages : new ArrayList<>();
            return this;
        }

        /**
         * Adds a single message to the initial conversation history.
         *
         * @param message the message to add to the initial conversation
         * @return this builder instance for method chaining
         */
        public Builder addMessage(BaseMessage message) {
            if (this.messages == null) {
                this.messages = new ArrayList<>();
            }
            this.messages.add(message);
            return this;
        }

        /**
         * Sets the initial agent state.
         *
         * @param state the initial state, or null for default empty state
         * @return this builder instance for method chaining
         */
        public Builder state(State state) {
            this.state = state != null ? state : new State();
            return this;
        }

        /**
         * Sets the debug flag to the specified value.
         *
         * @param debug whether to enable debug logging and output
         * @return this builder instance for method chaining
         */
        public Builder debug(boolean debug) {
            this.debug = debug;
            return this;
        }

        /**
         * Enables debug mode (equivalent to debug(true)).
         *
         * @return this builder instance for method chaining
         */
        public Builder debug() {
            this.debug = true;
            return this;
        }

        /**
         * Validates that all required parameters have been set.
         *
         * @throws IllegalArgumentException if any required parameter is missing or invalid
         */
        private void validate() {
            if (threadId == null || threadId.trim().isEmpty()) {
                throw new IllegalArgumentException("threadId is required");
            }
            if (httpClient == null) {
                throw new IllegalArgumentException("http client is required");
            }
        }

        /**
         * Constructs a new HttpAgent instance with the current configuration.
         * <p>
         * This method validates all required parameters before construction and
         * throws IllegalArgumentException if any required parameter is missing.
         *
         * @return a new configured HttpAgent instance
         * @throws IllegalArgumentException if required parameters are missing or invalid
         */
        public HttpAgent build() {
            validate();
            return new HttpAgent(agentId, description, threadId, httpClient, messages, state, debug);
        }
    }

    /**
     * Creates a new Builder instance for constructing HttpAgent instances.
     *
     * @return a new Builder instance
     */
    public static Builder builder() {
        return new Builder();
    }

}