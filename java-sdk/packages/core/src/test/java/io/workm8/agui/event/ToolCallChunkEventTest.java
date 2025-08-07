package io.workm8.agui.event;

import io.workm8.agui.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ToolCallChunkEvent")
public class ToolCallChunkEventTest {

    @Test
    public void itShouldMapProperties() {
        var event = new ToolCallChunkEvent();

        var toolCallId = UUID.randomUUID().toString();
        var parentMessageId = UUID.randomUUID().toString();
        var toolCallName = "tool";
        var delta = "delta";

        event.setToolCallId(toolCallId);
        event.setParentMessageId(parentMessageId);
        event.setToolCallName(toolCallName);
        event.setDelta(delta);

        assertThat(event.getType()).isEqualTo(EventType.TOOL_CALL_CHUNK);
        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(500L));
        assertThat(event.getRawEvent()).isNull();
        assertThat(event.getToolCallId()).isEqualTo(toolCallId);
        assertThat(event.getParentMessageId()).isEqualTo(parentMessageId);
        assertThat(event.getToolCallName()).isEqualTo(toolCallName);
        assertThat(event.getDelta()).isEqualTo(delta);
    }
}
