package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("RunStartedEvent")
class RunStartedEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new RunStartedEvent();

        assertThat(event.getType()).isEqualTo(EventType.RUN_STARTED);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new RunStartedEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetThreadId() {
        var threadId = UUID.randomUUID().toString();
        var event = new RunStartedEvent();
        event.setThreadId(threadId);

        assertThat(event.getThreadId()).isEqualTo(threadId);
    }

    @Test
    void shouldSetRunId() {
        var runId = UUID.randomUUID().toString();
        var event = new RunStartedEvent();
        event.setRunId(runId);

        assertThat(event.getRunId()).isEqualTo(runId);
    }
}