package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("StepStartedEvent")
class StepStartedEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new StepStartedEvent();

        assertThat(event.getType()).isEqualTo(EventType.STEP_STARTED);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new StepStartedEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetStepName() {
        var event = new StepStartedEvent();
        var name = "STEP";
        event.setStepName(name);

        assertThat(event.getStepName()).isEqualTo(name);
    }
}