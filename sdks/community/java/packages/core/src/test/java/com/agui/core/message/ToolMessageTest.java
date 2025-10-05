package com.agui.core.message;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ToolMessage")
class ToolMessageTest {

    @Test
    void shouldSetRole() {
        var message = new ToolMessage();

        assertThat(message.getRole()).isEqualTo(Role.tool);
    }

    @Test
    void shouldSetParameters() {
        var message = new ToolMessage();
        var id = UUID.randomUUID().toString();
        var content = "content";
        var error = "Error";

        message.setToolCallId(id);
        message.setContent(content);
        message.setError(error);

        assertThat(message.getToolCallId()).isEqualTo(id);
        assertThat(message.getContent()).isEqualTo(content);
        assertThat(message.getError()).isEqualTo(error);
    }
}