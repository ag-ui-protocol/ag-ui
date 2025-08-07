package io.workm8.agui.event;

import io.workm8.agui.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("TextMessageStartEvent")
public class TextMessageStartEventTest {

    @Test
    public void itShouldMapProperties() {
        var event = new TextMessageStartEvent();

        var messageId = UUID.randomUUID().toString();
        var role = "ROLE";

        event.setMessageId(messageId);
        event.setRole(role);

        assertThat(event.getType()).isEqualTo(EventType.TEXT_MESSAGE_START);
        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(500L));
        assertThat(event.getRawEvent()).isNull();
        assertThat(event.getMessageId()).isEqualTo(messageId);
        assertThat(event.getRole()).isEqualTo(role);
    }
}
