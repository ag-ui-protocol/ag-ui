package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ReasoningMessageStartEvent")
class ReasoningMessageStartEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new ReasoningMessageStartEvent();

        assertThat(event.getType()).isEqualTo(EventType.REASONING_MESSAGE_START);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new ReasoningMessageStartEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetMessageId() {
        var event = new ReasoningMessageStartEvent();
        var id = UUID.randomUUID().toString();
        event.setMessageId(id);

        assertThat(event.getMessageId()).isEqualTo(id);
    }

    @Test
    void shouldSetRole() {
        var event = new ReasoningMessageStartEvent();
        event.setRole("reasoning");

        assertThat(event.getRole()).isEqualTo("reasoning");
    }
}
