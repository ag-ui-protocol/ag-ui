package io.workm8.agui.event;

import io.workm8.agui.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("RunStartedEvent")
public class RunStartedEventTest {

    @Test
    public void itShouldMapProperties() {
        var event = new RunStartedEvent();

        var threadId = UUID.randomUUID().toString();
        var runId = UUID.randomUUID().toString();
        var result = "Done";

        event.setThreadId(threadId);
        event.setRunId(runId);

        assertThat(event.getType()).isEqualTo(EventType.RUN_STARTED);
        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(500L));
        assertThat(event.getRawEvent()).isNull();
        assertThat(event.getThreadId()).isEqualTo(threadId);
        assertThat(event.getRunId()).isEqualTo(runId);
    }
}
