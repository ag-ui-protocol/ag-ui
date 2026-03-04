package com.agui.core.event;

import com.agui.core.message.DeveloperMessage;
import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("MessagesSnapshotEvent")
class MessagesSnapshotEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new MessagesSnapshotEvent();

        assertThat(event.getType()).isEqualTo(EventType.MESSAGES_SNAPSHOT);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new MessagesSnapshotEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetMessages() {
        var event = new MessagesSnapshotEvent();
        var message = new DeveloperMessage();
        event.setMessages(List.of(message));

        assertThat(event.getMessages()).containsExactly(message);
    }
}