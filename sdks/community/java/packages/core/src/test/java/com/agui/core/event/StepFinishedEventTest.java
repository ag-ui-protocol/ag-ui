package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("StepFinishedEvent")
class StepFinishedEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new StepFinishedEvent();

        assertThat(event.getType()).isEqualTo(EventType.STEP_FINISHED);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new StepFinishedEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetStepName() {
        var event = new StepFinishedEvent();
        var name = "STEP";
        event.setStepName(name);

        assertThat(event.getStepName()).isEqualTo(name);
    }
}