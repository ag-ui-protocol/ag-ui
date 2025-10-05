package com.agui.core.agent;

import com.agui.core.message.BaseMessage;
import com.agui.core.state.State;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CompletableFuture;

import static java.util.Collections.emptyList;
import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("AgentSubscriberParams")
class AgentSubscriberParamsTest {

    @Test
    void shouldCreateAgentSubscriberParams() {
        List<BaseMessage> messages = emptyList();
        var state = new State();
        var agent = new Agent() {
            @Override
            public CompletableFuture<Void> runAgent(RunAgentParameters parameters, AgentSubscriber subscriber) {
                return null;
            }
            @Override
            public List<BaseMessage> getMessages() {
                return messages;
            }
        };
        var input = new RunAgentInput("", "", state, emptyList(), emptyList(), emptyList(), null);

        var sut = new AgentSubscriberParams(messages, state, agent, input);

        assertThat(sut.messages()).isEqualTo(messages);
        assertThat(sut.state()).isEqualTo(state);
        assertThat(sut.agent()).isEqualTo(agent);
        assertThat(sut.input()).isEqualTo(input);
    }
}