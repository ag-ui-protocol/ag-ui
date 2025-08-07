package io.workm8.agui.event;

import io.workm8.agui.message.UserMessage;
import io.workm8.agui.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("MessagesSnapshotEvent")
public class MessagesSnapshotEventTest {

    @Test
    public void itShouldMapProperties() {
        var event = new MessagesSnapshotEvent();
        event.setMessages(List.of(
                new UserMessage()
        ));
        assertThat(event.getType()).isEqualTo(EventType.MESSAGES_SNAPSHOT);
        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(500L));
        assertThat(event.getRawEvent()).isNull();
        assertThat(event.getMessages()).hasSize(1);
    }
}