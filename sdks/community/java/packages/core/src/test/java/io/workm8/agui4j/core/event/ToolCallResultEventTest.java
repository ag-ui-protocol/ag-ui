package io.workm8.agui4j.core.event;

import io.workm8.agui4j.core.message.Role;
import io.workm8.agui4j.core.type.EventType;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ToolCallResultEvent")
class ToolCallResultEventTest {

    @Test
    void shouldSetCorrectEventType() {
        var event = new ToolCallResultEvent();

        assertThat(event.getType()).isEqualTo(EventType.TOOL_CALL_RESULT);
    }

    @Test
    void shouldSetCurrentTimestamp() {
        var event = new ToolCallResultEvent();

        assertThat(event.getTimestamp()).isCloseTo(Instant.now().toEpochMilli(), Offset.offset(1000L));
    }

    @Test
    void shouldSetId() {
        var event = new ToolCallResultEvent();
        var id = UUID.randomUUID().toString();
        event.setToolCallId(id);

        assertThat(event.getToolCallId()).isEqualTo(id);
    }

    @Test
    void shouldSetMessageId() {
        var event = new ToolCallResultEvent();
        var id = UUID.randomUUID().toString();
        event.setMessageId(id);

        assertThat(event.getMessageId()).isEqualTo(id);
    }

    @Test
    void shouldSetRole() {
        var event = new ToolCallResultEvent();
        var role = Role.User;
        event.setRole(role);
        assertThat(event.getRole()).isEqualTo(role);
    }

    @Test
    void shouldSetContent() {
        var event =  new ToolCallResultEvent();
        var content = "content";
        event.setContent(content);

        assertThat(event.getContent()).isEqualTo(content);
    }
}