package com.agui.community.core.event;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.stream.IntStream;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class TokenUsageTest {

    static Stream<Arguments> counters() {
        String[] names = {"inputTokens", "outputTokens", "totalTokens", "reasoningTokens",
                "cachedInputTokens", "cacheWriteInputTokens"};
        return IntStream.range(0, names.length).mapToObj(index -> Arguments.of(index, names[index]));
    }

    private static TokenUsage withCount(int index, Long count) {
        Long[] counts = new Long[6];
        counts[index] = count;
        return new TokenUsage(null, null, counts[0], counts[1], counts[2], counts[3], counts[4], counts[5]);
    }

    @ParameterizedTest(name = "{1}")
    @MethodSource("counters")
    void acceptsOnlyNonNegativeSafeIntegerCounts(int index, String field) {
        assertDoesNotThrow(() -> withCount(index, null));
        assertDoesNotThrow(() -> withCount(index, 0L));
        assertDoesNotThrow(() -> withCount(index, 9_007_199_254_740_991L));

        for (long invalid : new long[] {-1L, 9_007_199_254_740_992L}) {
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                    () -> withCount(index, invalid));
            assertTrue(error.getMessage().contains(field));
        }
    }

    @Test
    void preservesPartialUsageWithoutInventingCounts() {
        TokenUsage usage = new TokenUsage("example", "model", null, null, 17L, null, null, null);

        assertEquals(17L, usage.totalTokens());
        assertNull(usage.inputTokens());
        assertNull(usage.outputTokens());
        assertNull(usage.reasoningTokens());
    }
}
