package com.agui.community.core.event;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

class RunUsageTest {

    private static final TokenUsage USAGE =
            new TokenUsage("example", "model", 10L, 5L, 15L, null, null, null);

    @Test
    void originalConstructorsLeaveUsageUnknown() {
        assertNull(new RunFinishedEvent("thread", "run").usage());
        assertNull(new RunFinishedEvent("thread", "run", null, "done", 1L, "raw").usage());
        assertNull(new RunErrorEvent("failure").usage());
        assertNull(new RunErrorEvent("failure", "code", 1L, "raw").usage());
    }

    @Test
    void snapshotsUsageForBothTerminalEvents() {
        List<TokenUsage> original = new ArrayList<>(List.of(USAGE));
        var finished = new RunFinishedEvent("thread", "run", null, null, original, null, null);
        var error = new RunErrorEvent("failure", null, original, null, null);

        original.clear();

        assertEquals(List.of(USAGE), finished.usage());
        assertEquals(List.of(USAGE), error.usage());
        assertThrows(UnsupportedOperationException.class, () -> finished.usage().clear());
        assertThrows(UnsupportedOperationException.class, () -> error.usage().clear());
    }

    @Test
    void preservesExplicitEmptyUsage() {
        var finished = new RunFinishedEvent("thread", "run", null, null, List.of(), null, null);
        var error = new RunErrorEvent("failure", null, List.of(), null, null);

        assertNotNull(finished.usage());
        assertNotNull(error.usage());
        assertTrue(finished.usage().isEmpty());
        assertTrue(error.usage().isEmpty());
    }

    @Test
    void rejectsNullEntriesInUsage() {
        List<TokenUsage> usage = Arrays.asList((TokenUsage) null);

        assertThrows(NullPointerException.class,
                () -> new RunFinishedEvent("thread", "run", null, null, usage, null, null));
        assertThrows(NullPointerException.class,
                () -> new RunErrorEvent("failure", null, usage, null, null));
    }
}
