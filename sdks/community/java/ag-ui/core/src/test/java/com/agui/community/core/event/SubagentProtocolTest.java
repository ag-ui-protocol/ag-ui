package com.agui.community.core.event;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import com.agui.community.core.message.Role;
import com.agui.community.core.serialization.SerializationException;
import com.agui.community.core.serialization.Serializer;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.annotation.JsonValue;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.jsontype.NamedType;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/** Protocol fixtures exercise the Serializer seam without a runtime JSON dependency. */
class SubagentProtocolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    static Stream<Arguments> protocolFrames() throws IOException {
        try (InputStream input = SubagentProtocolTest.class.getResourceAsStream("/subagent-events.json")) {
            assertNotNull(input, "protocol fixtures must be packaged as test resources");
            List<Arguments> cases = new ArrayList<>();
            for (JsonNode entry : JSON.readTree(input)) {
                cases.add(Arguments.of(entry.path("name").asText(), entry.path("model").asText(), entry.get("event")));
            }
            return cases.stream();
        }
    }

    static Stream<Arguments> parentAgentFrames() throws IOException {
        return protocolFrames()
                .filter(args -> !((JsonNode) args.get()[2]).path("type").asText().startsWith("SUBAGENT_"))
                .map(args -> {
                    ObjectNode frame = ((ObjectNode) args.get()[2]).deepCopy();
                    frame.remove("subagentRunId");
                    return Arguments.of(args.get()[0], args.get()[1], frame);
                });
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("protocolFrames")
    void roundTripsSubagentFramesThroughTheEventDiscriminator(String name, String model, JsonNode frame)
            throws IOException {
        assertRoundTrip(model, frame);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("parentAgentFrames")
    void parentAgentFramesRemainUnattributed(String name, String model, JsonNode frame) throws IOException {
        assertRoundTrip(model, frame);
    }

    private void assertRoundTrip(String model, JsonNode frame) throws IOException {
        // Resolve the fixture's expected model at runtime so missing protocol models
        // fail as behavior assertions, without requiring a new API just to compile.
        Class<? extends Event> eventClass = assertDoesNotThrow(() ->
                Class.forName(Event.class.getPackageName() + "." + model).asSubclass(Event.class));
        ObjectMapper mapper = new ObjectMapper()
                .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .setSerializationInclusion(JsonInclude.Include.NON_NULL);
        mapper.addMixIn(Event.class, WireEvent.class);
        mapper.addMixIn(Role.class, WireRole.class);
        mapper.registerSubtypes(new NamedType(eventClass, frame.path("type").asText()));
        Serializer serializer = new FixtureSerializer(mapper);

        Event event = assertDoesNotThrow(() -> serializer.deserialize(frame.toString(), Event.class));
        assertEquals(eventClass, event.getClass());
        assertEquals(frame.path("type").asText(), event.type().value());
        JsonNode written = JSON.readTree(serializer.serialize(event));
        assertEquals(frame, written, "wire fields must survive both directions without added nulls");
        assertEquals(event, serializer.deserialize(written.toString(), Event.class));
    }

    @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
    private interface WireEvent {
    }

    private abstract static class WireRole {
        @JsonValue
        public abstract String value();

        @JsonCreator
        public static Role fromValue(String value) {
            return Role.fromValue(value);
        }
    }

    private static final class FixtureSerializer implements Serializer {
        private final ObjectMapper mapper;

        private FixtureSerializer(ObjectMapper mapper) {
            this.mapper = mapper;
        }

        @Override
        public String serialize(Object value) {
            try {
                return mapper.writeValueAsString(value);
            } catch (IOException e) {
                throw new SerializationException("Cannot serialize fixture", e);
            }
        }

        @Override
        public <T> T deserialize(String json, Class<T> type) {
            try {
                return mapper.readValue(json, type);
            } catch (IOException e) {
                throw new SerializationException("Cannot deserialize fixture", e);
            }
        }

        @Override
        public <T> List<T> deserializeList(String json, Class<T> elementType) {
            try {
                return mapper.readValue(json, mapper.getTypeFactory().constructCollectionType(List.class, elementType));
            } catch (IOException e) {
                throw new SerializationException("Cannot deserialize fixture list", e);
            }
        }
    }
}
