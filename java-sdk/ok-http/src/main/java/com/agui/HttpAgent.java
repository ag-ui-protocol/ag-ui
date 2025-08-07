package com.agui;

import com.agui.client.AbstractAgent;
import com.agui.event.*;
import com.agui.types.State;
import com.agui.message.BaseMessage;
import com.agui.types.RunAgentInput;
import io.reactivex.Observable;

import java.util.ArrayList;
import java.util.List;

public class HttpAgent extends AbstractAgent {

    protected final HttpClient httpClient;

    private HttpAgent(
        final String agentId,
        final String description,
        final String threadId,
        final String url,
        final List<BaseMessage> messages,
        final State state,
        final boolean debug
    ) {
        super(agentId, description, threadId, messages, state, debug);

        this.httpClient = new HttpClient(url);
    }

    @Override
    protected Observable<BaseEvent> run(RunAgentInput input) {
        return this.httpClient.streamEvents(input);
    }

    public static class Builder {
        private String agentId;
        private String description = "";
        private String threadId;
        private String url;
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

        public Builder url(String url) {
            this.url = url;
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
            if (url == null || url.trim().isEmpty()) {
                throw new IllegalArgumentException("url is required");
            }
        }

        public HttpAgent build() {
            validate();
            return new HttpAgent(agentId, description, threadId, url, messages, state, debug);
        }
    }

    public static Builder builder() {
        return new Builder();
    }

    public static Builder withUrl(String url) {
        return new Builder().url(url);
    }

    public static Builder withAgentId(String agentId) {
        return new Builder().agentId(agentId);
    }

}
