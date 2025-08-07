package io.workm8.agui.event;

import io.workm8.agui.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

public class TextMessageChunkEventTest {

    @Test
    public void itShouldMapProperties() {
        var event = new TextMessageChunkEvent();

        var messageId = UUID.randomUUID().toString();
        var delta = "DELTA";
        var role = "ROLE";

        event.setMessageId(messageId);
        event.setDelta(delta);
        event.setRole(role);

        assertThat(event.getType()).isEqualTo(EventType.TEXT_MESSAGE_CHUNK);
        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(500L));
        assertThat(event.getRawEvent()).isNull();
        assertThat(event.getMessageId()).isEqualTo(messageId);
        assertThat(event.getDelta()).isEqualTo(delta);
        assertThat(event.getRole()).isEqualTo(role);
    }
}
