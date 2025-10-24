package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("RawEvent")
class RawEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new RawEvent();

        assertThat(event.getType()).isEqualTo(EventType.RAW);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new RawEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }
}