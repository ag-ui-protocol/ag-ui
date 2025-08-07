package io.workm8.agui.event;

import io.workm8.agui.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ToolCallEndEvent")
public class ToolCallEndEventTest {

    @Test
    public void itShouldMapProperties() {
        var event = new ToolCallEndEvent();

        var toolCallId = UUID.randomUUID().toString();

        event.setToolCallId(toolCallId);

        assertThat(event.getType()).isEqualTo(EventType.TOOL_CALL_END);
        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(500L));
        assertThat(event.getRawEvent()).isNull();
        assertThat(event.getToolCallId()).isEqualTo(toolCallId);
    }
}
