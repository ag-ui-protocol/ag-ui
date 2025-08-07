package io.workm8.agui.event;

import io.workm8.agui.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("StateDelta")
public class StateDeltaEventTest {

    @Test
    public void itShouldMapProperties() {
        var event = new StateDeltaEvent();

        assertThat(event.getType()).isEqualTo(EventType.STATE_DELTA);
        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(500L));
        assertThat(event.getRawEvent()).isNull();
    }
}
