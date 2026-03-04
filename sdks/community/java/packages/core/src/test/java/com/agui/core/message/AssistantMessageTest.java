package com.agui.core.message;

import com.agui.core.function.FunctionCall;
import com.agui.core.tool.ToolCall;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("AssistantMessage")
class AssistantMessageTest {

    @Test
    void shouldSetRole() {
        var message = new AssistantMessage();

        assertThat(message.getRole()).isEqualTo(Role.assistant);
    }

    @Test
    void shouldAddToolCall() {
        var id = UUID.randomUUID().toString();
        var toolCall = new ToolCall(id, "type", new FunctionCall("function", "{}"));

        var message = new AssistantMessage();
        assertThat(message.getToolCalls()).isEmpty();
        message.setToolCalls(null);
        message.addToolCall(toolCall);

        assertThat(message.getToolCalls()).containsExactly(toolCall);
    }

    @Test
    void shouldSetParameters() {
        var id = UUID.randomUUID().toString();
        var name = "Assistant";
        var content = "Content";

        var message = new AssistantMessage();
        message.setId(id);
        message.setName(name);
        message.setContent(content);

        assertThat(message.getId()).isEqualTo(id);
        assertThat(message.getName()).isEqualTo(name);
        assertThat(message.getContent()).isEqualTo(content);
        assertThat(message.getToolCalls()).isEmpty();
    }
}