package io.workm8.agui.event;

import io.workm8.agui.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ToolCallStartEvent")
public class ToolCallStartEventTest {

    @Test
    public void itShouldMapProperties() {
        var event = new ToolCallStartEvent();

        var toolCallId = UUID.randomUUID().toString();
        var parentMessageId = UUID.randomUUID().toString();
        var toolCallName = "tool";

        event.setToolCallId(toolCallId);
        event.setParentMessageId(parentMessageId);
        event.setToolCallName(toolCallName);

        assertThat(event.getType()).isEqualTo(EventType.TOOL_CALL_START);
        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(500L));
        assertThat(event.getRawEvent()).isNull();
        assertThat(event.getToolCallId()).isEqualTo(toolCallId);
        assertThat(event.getParentMessageId()).isEqualTo(parentMessageId);
        assertThat(event.getToolCallName()).isEqualTo(toolCallName);
    }
}
