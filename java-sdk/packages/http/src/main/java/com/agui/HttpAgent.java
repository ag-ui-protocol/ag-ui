package com.agui;

import com.agui.client.AbstractAgent;
import com.agui.event.*;
import com.agui.types.State;
import com.agui.message.BaseMessage;
import com.agui.types.RunAgentInput;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;

public class HttpAgent extends AbstractAgent {

    protected final HttpClient httpClient;

    private HttpAgent(
        final String agentId,
        final String description,
        final String threadId,
        final HttpClient httpClient,
        final List<BaseMessage> messages,
        final State state,
        final boolean debug
    ) {
        super(agentId, description, threadId, messages, state, debug);

        this.httpClient = httpClient;
    }

    @Override
    protected CompletableFuture<Void> run(RunAgentInput input, Consumer<BaseEvent> eventHandler) {
        // Fixed: Now properly passing the eventHandler to the HTTP client
        return this.httpClient.streamEvents(input, eventHandler);
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
        private HttpClient httpClient;
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

        public Builder httpClient(HttpClient httpClient) {
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

    public static Builder withHttpClient(HttpClient httpClient) {
        return new Builder().httpClient(httpClient);
    }

    public static Builder withAgentId(String agentId) {
        return new Builder().agentId(agentId);
    }

}