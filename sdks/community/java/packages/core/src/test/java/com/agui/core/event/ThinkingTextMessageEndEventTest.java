package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ThinkingTextMessageEndEvent")
class ThinkingTextMessageEndEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new ThinkingTextMessageEndEvent();

        assertThat(event.getType()).isEqualTo(EventType.THINKING_TEXT_MESSAGE_END);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new ThinkingTextMessageEndEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

}