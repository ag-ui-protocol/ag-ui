package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("RunErrorEvent")
class RunErrorEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new RunErrorEvent();

        assertThat(event.getType()).isEqualTo(EventType.RUN_ERROR);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new RunErrorEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetErrorMessage() {
        var event = new RunErrorEvent();
        var error = "ERROR";

        event.setError(error);

        assertThat(event.getError()).isEqualTo(error);
    }
}