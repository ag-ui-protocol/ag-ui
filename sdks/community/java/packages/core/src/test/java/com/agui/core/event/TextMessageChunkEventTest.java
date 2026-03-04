package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("TextMessageChunkEvent")
class TextMessageChunkEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new TextMessageChunkEvent();

        assertThat(event.getType()).isEqualTo(EventType.TEXT_MESSAGE_CHUNK);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new TextMessageChunkEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetMessageId() {
        var event = new TextMessageChunkEvent();
        var id = UUID.randomUUID().toString();
        event.setMessageId(id);

        assertThat(event.getMessageId()).isEqualTo(id);
    }

    @Test
    void shouldSetDelta() {
        var event = new TextMessageChunkEvent();
        var delta = "DELTA";
        event.setDelta(delta);

        assertThat(event.getDelta()).isEqualTo(delta);
    }

    @Test
    void shouldSetRole() {
        var event = new TextMessageChunkEvent();
        var role = "ROLE";
        event.setRole(role);

        assertThat(event.getRole()).isEqualTo(role);
    }
}