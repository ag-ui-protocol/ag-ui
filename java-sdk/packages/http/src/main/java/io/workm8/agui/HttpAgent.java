package io.workm8.agui;

import io.workm8.agui.client.AbstractAgent;
import io.workm8.agui.client.stream.IEventStream;
import io.workm8.agui.state.State;
import io.workm8.agui.message.BaseMessage;
import io.workm8.agui.input.RunAgentInput;
import io.workm8.agui.event.BaseEvent;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

public class HttpAgent extends AbstractAgent {

    protected final BaseHttpClient httpClient;

    private HttpAgent(
        final String agentId,
        final String description,
        final String threadId,
        final BaseHttpClient httpClient,
        final List<BaseMessage> messages,
        final State state,
        final boolean debug
    ) {
        super(agentId, description, threadId, messages, state, debug);

        this.httpClient = httpClient;
    }

    @Override
    protected void run(RunAgentInput input, IEventStream<BaseEvent> stream) {
        AtomicBoolean cancellationToken = new AtomicBoolean(false);

        CompletableFuture<Void> httpFuture = httpClient.streamEventsWithCancellation(
                input,
                event -> {
                    if (!stream.isCancelled()) {
                        stream.next(event);  // Multiple .next() calls - one per HTTP event
                    }
                },
                cancellationToken
        );

        httpFuture.whenComplete((result, error) -> {
            if (error != null) {
                stream.error(error);
            } else {
                stream.complete();  // Only call once when HTTP stream ends
            }
        });
    }

    /**
     * Close the underlying HTTP client when the agent is no longer needed
     */
    public void close() {
        if (httpClient != null) {
            httpClient.close();
        }
    }

    public static class Builder {
        private String agentId;
        private String description = "";
        private String threadId;
        private BaseHttpClient httpClient;
        private List<BaseMessage> messages = new ArrayList<>();
        private State state = new State();
        private boolean debug = false;

        public Builder() {}

        public Builder agentId(String agentId) {
            this.agentId = agentId;
            return this;
        }

        public Builder description(String description) {
            this.description = description;
            return this;
        }

        public Builder threadId(String threadId) {
            this.threadId = threadId;
            return this;
        }

        public Builder httpClient(BaseHttpClient httpClient) {
            this.httpClient = httpClient;
            return this;
        }

        public Builder messages(List<BaseMessage> messages) {
            this.messages = messages != null ? messages : new ArrayList<>();
            return this;
        }

        public Builder addMessage(BaseMessage message) {
            if (this.messages == null) {
                this.messages = new ArrayList<>();
            }
            this.messages.add(message);
            return this;
        }

        public Builder state(State state) {
            this.state = state != null ? state : new State();
            return this;
        }

        public Builder debug(boolean debug) {
            this.debug = debug;
            return this;
        }

        public Builder debug() {
            this.debug = true;
            return this;
        }

        private void validate() {
            if (agentId == null || agentId.trim().isEmpty()) {
                throw new IllegalArgumentException("agentId is required");
            }
            if (threadId == null || threadId.trim().isEmpty()) {
                throw new IllegalArgumentException("threadId is required");
            }
            if (httpClient == null) {
                throw new IllegalArgumentException("http client is required");
            }
        }

        public HttpAgent build() {
            validate();
            return new HttpAgent(agentId, description, threadId, httpClient, messages, state, debug);
        }
    }

    public static Builder builder() {
        return new Builder();
    }

    public static Builder withHttpClient(BaseHttpClient httpClient) {
        return new Builder().httpClient(httpClient);
    }

    public static Builder withAgentId(String agentId) {
        return new Builder().agentId(agentId);
    }

}