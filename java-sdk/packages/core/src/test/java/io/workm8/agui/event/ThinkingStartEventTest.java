package io.workm8.agui.event;

import io.workm8.agui.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ThinkingStartEvent")
public class ThinkingStartEventTest {

    @Test
    public void itShouldMapProperties() {
        var event = new ThinkingStartEvent();

        assertThat(event.getType()).isEqualTo(EventType.THINKING_START);
        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(500L));
        assertThat(event.getRawEvent()).isNull();
    }
}
