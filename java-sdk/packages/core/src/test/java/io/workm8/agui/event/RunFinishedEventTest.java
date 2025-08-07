package io.workm8.agui.event;

import io.workm8.agui.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("RunFinishedEvent")
public class RunFinishedEventTest {

    @Test
    public void itShouldMapProperties() {
        var event = new RunFinishedEvent();

        var threadId = UUID.randomUUID().toString();
        var runId = UUID.randomUUID().toString();
        var result = "Done";

        event.setThreadId(threadId);
        event.setRunId(runId);
        event.setResult(result);

        assertThat(event.getType()).isEqualTo(EventType.RUN_FINISHED);
        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(500L));
        assertThat(event.getRawEvent()).isNull();
        assertThat(event.getThreadId()).isEqualTo(threadId);
        assertThat(event.getRunId()).isEqualTo(runId);
        assertThat(event.getResult()).isEqualTo(result);
    }

}
