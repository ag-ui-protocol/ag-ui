package com.agui.core.agent;

import com.agui.core.context.Context;
import com.agui.core.message.BaseMessage;
import com.agui.core.message.UserMessage;
import com.agui.core.state.State;
import com.agui.core.tool.Tool;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("RunAgentInput")
class RunAgentInputTest {

    @Test
    void shouldCreateWithAllParameters() {
        var threadId = "thread-123";
        var runId = "run-456";
        var state = new State();
        state.set("key", "value");
        var userMessage = new UserMessage();
        userMessage.setId("test-id");
        userMessage.setContent("Hello");
        userMessage.setName("user");
        var messages = List.<BaseMessage>of(userMessage);
        var tools = List.<Tool>of();
        var context = List.<Context>of();
        var forwardedProps = Map.of("prop", "value");

        var input = new RunAgentInput(threadId, runId, state, messages, tools, context, forwardedProps);

        assertThat(input.threadId()).isEqualTo(threadId);
        assertThat(input.runId()).isEqualTo(runId);
        assertThat(input.state()).isEqualTo(state);
        assertThat(input.messages()).isEqualTo(messages);
        assertThat(input.tools()).isEqualTo(tools);
        assertThat(input.context()).isEqualTo(context);
        assertThat(input.forwardedProps()).isEqualTo(forwardedProps);
    }

    @Test
    void shouldBeImmutable() {
        var input1 = new RunAgentInput("thread", "run", null, List.of(), List.of(), List.of(), null);
        var input2 = new RunAgentInput("thread", "run", null, List.of(), List.of(), List.of(), null);

        assertThat(input1).isEqualTo(input2);
        assertThat(input1.hashCode()).isEqualTo(input2.hashCode());
    }

    @Test
    void shouldHandleNullValues() {
        var input = new RunAgentInput(null, null, null, null, null, null, null);

        assertThat(input.threadId()).isNull();
        assertThat(input.runId()).isNull();
        assertThat(input.state()).isNull();
        assertThat(input.messages()).isNull();
        assertThat(input.tools()).isNull();
        assertThat(input.context()).isNull();
        assertThat(input.forwardedProps()).isNull();
    }

    @Test
    void shouldHaveProperToString() {
        var input = new RunAgentInput("thread", "run", null, List.of(), List.of(), List.of(), "props");
        
        var toString = input.toString();
        
        assertThat(toString).contains("thread");
        assertThat(toString).contains("run");
        assertThat(toString).contains("props");
    }
}