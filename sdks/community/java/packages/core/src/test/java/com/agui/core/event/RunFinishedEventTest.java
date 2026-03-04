package com.agui.core.event;

import com.agui.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("RunFinishedEvent")
class RunFinishedEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new RunFinishedEvent();

        assertThat(event.getType()).isEqualTo(EventType.RUN_FINISHED);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new RunFinishedEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetThreadId() {
        var threadId = UUID.randomUUID().toString();
        var event = new RunFinishedEvent();
        event.setThreadId(threadId);

        assertThat(event.getThreadId()).isEqualTo(threadId);
    }

    @Test
    void shouldSetRunId() {
        var runId = UUID.randomUUID().toString();
        var event = new RunFinishedEvent();
        event.setRunId(runId);

        assertThat(event.getRunId()).isEqualTo(runId);
    }

    @Test
    void shouldSetResult() {
        var result = "RESULT";
        var event = new RunFinishedEvent();
        event.setResult(result);

        assertThat(event.getResult()).isEqualTo(result);
    }
}