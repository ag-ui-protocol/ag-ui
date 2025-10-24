package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("BaseEvent")
class BaseEventTest {

    @Test
    void shouldOverrideTimestamp() {
        var event = new TestEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));

        event.setTimestamp(0);
        assertThat(event.getTimestamp()).isEqualTo(0);
    }

    @Test
    void shouldSetRawEvent() {
        var event = new TestEvent();
        var raw = "RAW";
        event.setRawEvent(raw);

        assertThat(event.getRawEvent()).isEqualTo(raw);
    }

    @Test
    void shouldSetComplexRawEvent() {
        var event = new TestEvent();
        var raw = new TestEvent();
        event.setRawEvent(raw);

        assertThat(event.getRawEvent()).isEqualTo(raw);
    }

    static class TestEvent extends BaseEvent {

        public TestEvent() {
            super(EventType.CUSTOM);
        }
    }
}