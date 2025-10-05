package com.agui.server.spring;

import com.agui.core.context.Context;
import com.agui.core.message.BaseMessage;
import com.agui.core.message.UserMessage;
import com.agui.core.state.State;
import com.agui.core.tool.Tool;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static java.util.Collections.emptyList;
import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("AgUiParameters")
class AgUiParametersTest {

    private AgUiParameters parameters;

    @BeforeEach
    void setUp() {
        parameters = new AgUiParameters();
    }

    @Test
    void shouldSetAndGetThreadId() {
        var threadId = "thread-123";
        
        parameters.setThreadId(threadId);
        
        assertThat(parameters.getThreadId()).isEqualTo(threadId);
    }

    @Test
    void shouldSetAndGetRunId() {
        var runId = "run-456";
        
        parameters.setRunId(runId);
        
        assertThat(parameters.getRunId()).isEqualTo(runId);
    }

    @Test
    void shouldSetAndGetTools() {
        var tools = List.of(
            new Tool("tool1", "First tool", new Tool.ToolParameters("function", Map.of(), emptyList())),
            new Tool("tool2", "Second tool", new Tool.ToolParameters("function", Map.of(), emptyList()))
        );
        
        parameters.setTools(tools);
        
        assertThat(parameters.getTools()).isEqualTo(tools);
        assertThat(parameters.getTools()).hasSize(2);
    }

    @Test
    void shouldSetAndGetContext() {
        var context = List.<Context>of();
        
        parameters.setContext(context);
        
        assertThat(parameters.getContext()).isEqualTo(context);
    }

    @Test
    void shouldSetAndGetForwardedProps() {
        var props = Map.of("key", "value", "number", 42);
        
        parameters.setForwardedProps(props);
        
        assertThat(parameters.getForwardedProps()).isEqualTo(props);
    }

    @Test
    void shouldSetAndGetMessages() {
        var userMessage1 = new UserMessage();
        userMessage1.setId("1");
        userMessage1.setContent("Hello");

        var userMessage2 = new UserMessage();
        userMessage2.setId("2");
        userMessage2.setContent("How are you?");
        var messages = List.<BaseMessage>of(
            userMessage1,
            userMessage2
        );
        
        parameters.setMessages(messages);
        
        assertThat(parameters.getMessages()).isEqualTo(messages);
        assertThat(parameters.getMessages()).hasSize(2);
    }

    @Test
    void shouldSetAndGetState() {
        var state = new State();
        state.set("currentStep", "greeting");

        parameters.setState(state);
        
        assertThat(parameters.getState()).isEqualTo(state);
    }

    @Test
    void shouldHandleNullValues() {
        parameters.setThreadId(null);
        parameters.setRunId(null);
        parameters.setTools(null);
        parameters.setContext(null);
        parameters.setForwardedProps(null);
        parameters.setMessages(null);
        parameters.setState(null);
        
        assertThat(parameters.getThreadId()).isNull();
        assertThat(parameters.getRunId()).isNull();
        assertThat(parameters.getTools()).isNull();
        assertThat(parameters.getContext()).isNull();
        assertThat(parameters.getForwardedProps()).isNull();
        assertThat(parameters.getMessages()).isNull();
        assertThat(parameters.getState()).isNull();
    }

    @Test
    void shouldInitializeWithNullValues() {
        var newParams = new AgUiParameters();
        
        assertThat(newParams.getThreadId()).isNull();
        assertThat(newParams.getRunId()).isNull();
        assertThat(newParams.getTools()).isNull();
        assertThat(newParams.getContext()).isNull();
        assertThat(newParams.getForwardedProps()).isNull();
        assertThat(newParams.getMessages()).isNull();
        assertThat(newParams.getState()).isNull();
    }

    @Test
    void shouldSupportComplexForwardedProps() {
        var complexProps = Map.of(
            "nested", Map.of("deep", "value"),
            "list", List.of(1, 2, 3),
            "string", "simple"
        );
        
        parameters.setForwardedProps(complexProps);
        
        assertThat(parameters.getForwardedProps()).isEqualTo(complexProps);
    }
}