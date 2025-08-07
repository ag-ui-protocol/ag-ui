package io.workm8.agui.event;

import io.workm8.agui.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ToolCallResultEvent")
public class ToolCallResultEventTest {

    @Test
    public void itShouldMapProperties() {
        var event = new ToolCallResultEvent();

        var toolCallId = UUID.randomUUID().toString();
        var content = "content";
        var role = "role";
        var messageId = UUID.randomUUID().toString();

        event.setToolCallId(toolCallId);
        event.setContent(content);
        event.setRole(role);
        event.setMessageId(messageId);

        assertThat(event.getType()).isEqualTo(EventType.TOOL_CALL_RESULT);
        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(500L));
        assertThat(event.getRawEvent()).isNull();
        assertThat(event.getToolCallId()).isEqualTo(toolCallId);
        assertThat(event.getContent()).isEqualTo(content);
        assertThat(event.getRole()).isEqualTo(role);
        assertThat(event.getMessageId()).isEqualTo(messageId);
    }
}
