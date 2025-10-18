package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("TextMessageEndEvent")
class TextMessageEndEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new TextMessageEndEvent();

        assertThat(event.getType()).isEqualTo(EventType.TEXT_MESSAGE_END);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new TextMessageEndEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetMessageId() {
        var event = new TextMessageEndEvent();
        var id = UUID.randomUUID().toString();
        event.setMessageId(id);

        assertThat(event.getMessageId()).isEqualTo(id);
    }
}