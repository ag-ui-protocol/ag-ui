package com.agui.json;

import com.agui.core.event.BaseEvent;
import com.agui.core.event.ReasoningMessageContentEvent;
import com.agui.core.event.ReasoningMessageEndEvent;
import com.agui.core.event.ReasoningMessageStartEvent;
import com.agui.core.type.EventType;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Verifies Jackson polymorphic round-trip of the REASONING_MESSAGE_*
 * event family wired in {@link com.agui.json.mixins.EventMixin}. Each
 * payload mirrors the AG-UI TypeScript wire schema
 * (@ag-ui/core ReasoningMessage*EventSchema) so cross-SDK clients
 * decode emitted events identically.
 */
@DisplayName("REASONING_MESSAGE_* Jackson serde")
class ReasoningMessageEventSerdeTest {

    private ObjectMapper mapper;

    @BeforeEach
    void setUp() {
        mapper = new ObjectMapper();
        ObjectMapperFactory.addMixins(mapper);
    }

    @Test
    void shouldDeserializeReasoningMessageStartFromWirePayload() throws Exception {
        var json = """
                {
                  "type": "REASONING_MESSAGE_START",
                  "messageId": "msg-r1",
                  "role": "reasoning"
                }
                """;

        BaseEvent decoded = mapper.readValue(json, BaseEvent.class);

        assertThat(decoded).isInstanceOf(ReasoningMessageStartEvent.class);
        var start = (ReasoningMessageStartEvent) decoded;
        assertThat(start.getType()).isEqualTo(EventType.REASONING_MESSAGE_START);
        assertThat(start.getMessageId()).isEqualTo("msg-r1");
        assertThat(start.getRole()).isEqualTo("reasoning");
    }

    @Test
    void shouldDeserializeReasoningMessageContentFromWirePayload() throws Exception {
        var json = """
                {
                  "type": "REASONING_MESSAGE_CONTENT",
                  "messageId": "msg-r1",
                  "delta": "Considering"
                }
                """;

        BaseEvent decoded = mapper.readValue(json, BaseEvent.class);

        assertThat(decoded).isInstanceOf(ReasoningMessageContentEvent.class);
        var content = (ReasoningMessageContentEvent) decoded;
        assertThat(content.getType()).isEqualTo(EventType.REASONING_MESSAGE_CONTENT);
        assertThat(content.getMessageId()).isEqualTo("msg-r1");
        assertThat(content.getDelta()).isEqualTo("Considering");
    }

    @Test
    void shouldDeserializeReasoningMessageEndFromWirePayload() throws Exception {
        var json = """
                {
                  "type": "REASONING_MESSAGE_END",
                  "messageId": "msg-r1"
                }
                """;

        BaseEvent decoded = mapper.readValue(json, BaseEvent.class);

        assertThat(decoded).isInstanceOf(ReasoningMessageEndEvent.class);
        var end = (ReasoningMessageEndEvent) decoded;
        assertThat(end.getType()).isEqualTo(EventType.REASONING_MESSAGE_END);
        assertThat(end.getMessageId()).isEqualTo("msg-r1");
    }

    @Test
    void shouldRoundTripReasoningMessageStart() throws Exception {
        var original = new ReasoningMessageStartEvent();
        original.setMessageId("msg-r1");
        original.setRole("reasoning");

        var json = mapper.writeValueAsString(original);
        var decoded = mapper.readValue(json, BaseEvent.class);

        assertThat(decoded).isInstanceOf(ReasoningMessageStartEvent.class);
        var roundTripped = (ReasoningMessageStartEvent) decoded;
        assertThat(roundTripped.getMessageId()).isEqualTo(original.getMessageId());
        assertThat(roundTripped.getRole()).isEqualTo(original.getRole());
        assertThat(json).contains("\"type\":\"REASONING_MESSAGE_START\"");
    }

    @Test
    void shouldRoundTripReasoningMessageContent() throws Exception {
        var original = new ReasoningMessageContentEvent();
        original.setMessageId("msg-r1");
        original.setDelta("partial");

        var json = mapper.writeValueAsString(original);
        var decoded = mapper.readValue(json, BaseEvent.class);

        assertThat(decoded).isInstanceOf(ReasoningMessageContentEvent.class);
        var roundTripped = (ReasoningMessageContentEvent) decoded;
        assertThat(roundTripped.getMessageId()).isEqualTo(original.getMessageId());
        assertThat(roundTripped.getDelta()).isEqualTo(original.getDelta());
        assertThat(json).contains("\"type\":\"REASONING_MESSAGE_CONTENT\"");
    }

    @Test
    void shouldRoundTripReasoningMessageEnd() throws Exception {
        var original = new ReasoningMessageEndEvent();
        original.setMessageId("msg-r1");

        var json = mapper.writeValueAsString(original);
        var decoded = mapper.readValue(json, BaseEvent.class);

        assertThat(decoded).isInstanceOf(ReasoningMessageEndEvent.class);
        var roundTripped = (ReasoningMessageEndEvent) decoded;
        assertThat(roundTripped.getMessageId()).isEqualTo(original.getMessageId());
        assertThat(json).contains("\"type\":\"REASONING_MESSAGE_END\"");
    }
}
