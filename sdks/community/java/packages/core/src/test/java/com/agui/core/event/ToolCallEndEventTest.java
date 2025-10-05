package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ToolCallEndEvent")
class ToolCallEndEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new ToolCallEndEvent();

        assertThat(event.getType()).isEqualTo(EventType.TOOL_CALL_END);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new ToolCallEndEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetTool() {
        var id = UUID.randomUUID().toString();

        var event = new ToolCallEndEvent();
        event.setToolCallId(id);

        assertThat(event.getToolCallId()).isEqualTo(id);
    }
}