package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ToolCallChunkEvent")
class ToolCallChunkEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new ToolCallChunkEvent();

        assertThat(event.getType()).isEqualTo(EventType.TOOL_CALL_CHUNK);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new ToolCallChunkEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetId() {
        var event = new ToolCallChunkEvent();
        var id = UUID.randomUUID().toString();
        event.setToolCallId(id);

        assertThat(event.getToolCallId()).isEqualTo(id);
    }

    @Test
    void shouldSetName() {
        var event = new ToolCallChunkEvent();
        var name = "tool";
        event.setToolCallName(name);

        assertThat(event.getToolCallName()).isEqualTo(name);
    }

    @Test
    void shouldSetParentId() {
        var event = new ToolCallChunkEvent();
        var id = UUID.randomUUID().toString();
        event.setParentMessageId(id);

        assertThat(event.getParentMessageId()).isEqualTo(id);
    }

    @Test
    void shouldSetDelta() {
        var event = new ToolCallChunkEvent();
        var delta = "DELTA";
        event.setDelta(delta);

        assertThat(event.getDelta()).isEqualTo(delta);
    }

}