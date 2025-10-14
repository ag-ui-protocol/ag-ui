package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ToolCallStartEvent")
class ToolCallStartEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new ToolCallStartEvent();

        assertThat(event.getType()).isEqualTo(EventType.TOOL_CALL_START);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new ToolCallStartEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetId() {
        var event = new ToolCallStartEvent();
        var id = UUID.randomUUID().toString();
        event.setToolCallId(id);

        assertThat(event.getToolCallId()).isEqualTo(id);
    }

    @Test
    void shouldSetParentId() {
        var event = new ToolCallStartEvent();
        var id = UUID.randomUUID().toString();
        event.setParentMessageId(id);

        assertThat(event.getParentMessageId()).isEqualTo(id);
    }

    @Test
    void shouldSetName() {
        var event = new ToolCallStartEvent();
        var name = "tool";
        event.setToolCallName(name);

        assertThat(event.getToolCallName()).isEqualTo(name);
    }
}