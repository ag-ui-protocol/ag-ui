package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ToolCallArgsEvent")
class ToolCallArgsEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new ToolCallArgsEvent();

        assertThat(event.getType()).isEqualTo(EventType.TOOL_CALL_ARGS);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new ToolCallArgsEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetId() {
        var event = new ToolCallArgsEvent();
        var id = UUID.randomUUID().toString();
        event.setToolCallId(id);

        assertThat(event.getToolCallId()).isEqualTo(id);
    }

    @Test
    void shouldSetDelta() {
        var event = new ToolCallArgsEvent();
        var delta = "DELTA";
        event.setDelta(delta);

        assertThat(event.getDelta()).isEqualTo(delta);
    }
}