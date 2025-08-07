package io.workm8.agui.message;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ToolMessage")
public class ToolMessageTest {

    @Test
    public void itShouldMapProperties() {
        var message = new ToolMessage();

        var toolCallId = UUID.randomUUID().toString();
        var error = "error";

        message.setToolCallId(toolCallId);
        message.setError(error);

        assertThat(message.getRole()).isEqualTo("tool");
        assertThat(message.getContent()).isEqualTo("");
        assertThat(message.getId()).isNotNull();
        assertThat(message.getName()).isEqualTo("");
        assertThat(message.getToolCallId()).isEqualTo(toolCallId);
        assertThat(message.getError()).isEqualTo(error);
    }

}
