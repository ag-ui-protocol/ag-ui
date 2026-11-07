package com.agui.community.core.event;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class TokenUsageJsonTest {

    // Match the SDK serializer's optional-field and unknown-property policies.
    // Binding directly to each record keeps core independent of a JSON runtime.
    private final ObjectMapper mapper = new ObjectMapper()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .setSerializationInclusion(JsonInclude.Include.NON_NULL);

    private static final String FULL_USAGE = """
            [{"provider":"example","model":"model-a","inputTokens":2147483648,
              "outputTokens":0,"totalTokens":2147483648,"reasoningTokens":0,
              "cachedInputTokens":0,"cacheWriteInputTokens":0},
             {"provider":"example","model":"model-b","inputTokens":9007199254740991,
              "outputTokens":0,"totalTokens":9007199254740991}]
            """;

    static Stream<Class<? extends Event>> eventTypes() {
        return Stream.of(RunFinishedEvent.class, RunErrorEvent.class);
    }

    static Stream<Arguments> usageCases() {
        return eventTypes().flatMap(type -> Stream.of(
                Arguments.of(type, "counts and multiple models", FULL_USAGE),
                Arguments.of(type, "missing counters and explicit zero", "[{}, {\"outputTokens\":0}]"),
                Arguments.of(type, "explicit empty usage", "[]")));
    }

    private static String eventJson(Class<? extends Event> type, String usage) {
        String fields = type == RunFinishedEvent.class
                ? "\"type\":\"RUN_FINISHED\",\"threadId\":\"thread-1\",\"runId\":\"run-1\""
                : "\"type\":\"RUN_ERROR\",\"message\":\"The run failed\",\"code\":\"ModelError\"";
        return "{" + fields + (usage == null ? "" : ",\"usage\":" + usage) + "}";
    }

    @ParameterizedTest(name = "{0}: {1}")
    @MethodSource("usageCases")
    void retainsUsageThroughRecordBinding(Class<? extends Event> type, String description,
                                         String usage) throws Exception {
        Event event = mapper.readValue(eventJson(type, usage), type);
        JsonNode serialized = mapper.readTree(mapper.writeValueAsString(event));

        assertEquals(mapper.readTree(usage), serialized.get("usage"));
    }

    @ParameterizedTest
    @MethodSource("eventTypes")
    void leavesUsageAbsentOnLegacyEvents(Class<? extends Event> type) throws Exception {
        Event event = mapper.readValue(eventJson(type, null), type);
        JsonNode serialized = mapper.readTree(mapper.writeValueAsString(event));

        assertFalse(serialized.has("usage"));
    }
}
