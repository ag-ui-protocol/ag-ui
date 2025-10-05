package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("TextMessageContentEvent")
class TextMessageContentEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new TextMessageContentEvent();

        assertThat(event.getType()).isEqualTo(EventType.TEXT_MESSAGE_CONTENT);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new TextMessageContentEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetMessageId() {
        var event = new TextMessageContentEvent();
        var id = UUID.randomUUID().toString();
        event.setMessageId(id);

        assertThat(event.getMessageId()).isEqualTo(id);
    }

    @Test
    void shouldSetDelta() {
        var event = new TextMessageContentEvent();
        var delta = "DELTA";
        event.setDelta(delta);

        assertThat(event.getDelta()).isEqualTo(delta);
    }
}