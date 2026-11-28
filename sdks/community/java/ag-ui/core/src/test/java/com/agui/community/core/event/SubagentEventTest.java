package com.agui.community.core.event;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;

class SubagentEventTest {

    @Test
    void requiredConstructorsLeaveOptionalFieldsAbsent() {
        SubagentStartedEvent started = new SubagentStartedEvent("child", "researcher");
        assertEquals("child", started.subagentRunId());
        assertEquals("researcher", started.name());
        assertNull(started.description());
        assertNull(started.parentSubagentRunId());
        assertNull(started.parentToolCallId());
        assertNull(started.parentMessageId());

        SubagentFinishedEvent finished = new SubagentFinishedEvent("child");
        assertEquals("child", finished.subagentRunId());
        assertNull(finished.outcome());
        assertNull(finished.result());

        SubagentErrorEvent error = new SubagentErrorEvent("child", "Synthetic failure");
        assertEquals("child", error.subagentRunId());
        assertEquals("Synthetic failure", error.message());
        assertNull(error.code());
    }

    @Test
    void startedKeepsInvocationIdentitySeparateFromParentReferences() {
        Object raw = Map.of("source", "synthetic");
        SubagentStartedEvent event = new SubagentStartedEvent(
                "child", "researcher", "Lookup", "parent", "tool", "message", 123L, raw);

        assertEquals("child", event.subagentRunId());
        assertEquals("researcher", event.name());
        assertEquals("Lookup", event.description());
        assertEquals("parent", event.parentSubagentRunId());
        assertEquals("tool", event.parentToolCallId());
        assertEquals("message", event.parentMessageId());
        assertEquals(123L, event.timestamp());
        assertSame(raw, event.rawEvent());
    }

    @Test
    void finishedCarriesOutcomeResultAndBaseFields() {
        SubagentFinishedOutcome outcome = SubagentFinishedOutcome.suspended(List.of("approval"));
        Object result = Map.of("partial", true);
        Object raw = Map.of("source", "synthetic");
        SubagentFinishedEvent event = new SubagentFinishedEvent("child", outcome, result, 123L, raw);

        assertSame(outcome, event.outcome());
        assertSame(result, event.result());
        assertEquals(123L, event.timestamp());
        assertSame(raw, event.rawEvent());
    }

    @Test
    void errorCarriesCodeAndBaseFields() {
        Object raw = Map.of("source", "synthetic");
        SubagentErrorEvent event = new SubagentErrorEvent("child", "Synthetic failure", "lookup", 123L, raw);

        assertEquals("child", event.subagentRunId());
        assertEquals("Synthetic failure", event.message());
        assertEquals("lookup", event.code());
        assertEquals(123L, event.timestamp());
        assertSame(raw, event.rawEvent());
    }

    static Stream<Executable> missingRequiredFields() {
        return Stream.of(
                () -> new SubagentStartedEvent(null, "researcher"),
                () -> new SubagentStartedEvent("child", null),
                () -> new SubagentFinishedEvent(null),
                () -> new SubagentErrorEvent(null, "Synthetic failure"),
                () -> new SubagentErrorEvent("child", null));
    }

    @ParameterizedTest
    @MethodSource("missingRequiredFields")
    void requiredFieldsRejectNull(Executable constructor) {
        assertThrows(NullPointerException.class, constructor);
    }

    @Test
    void successHasNoInterruptList() {
        SubagentFinishedOutcome success = SubagentFinishedOutcome.success();

        assertEquals("success", success.type());
        assertNull(success.interruptIds());
    }

    @Test
    void suspendedPreservesAbsentVersusEmptyInterruptList() {
        SubagentFinishedOutcome absent = SubagentFinishedOutcome.suspended();
        SubagentFinishedOutcome empty = SubagentFinishedOutcome.suspended(List.of());

        assertEquals("suspended", absent.type());
        assertNull(absent.interruptIds());
        assertEquals(List.of(), empty.interruptIds());
        assertEquals(absent, SubagentFinishedOutcome.suspended(null));
        assertNotEquals(absent, empty);
    }

    @Test
    void suspendedCopiesAndProtectsItsOwnedInterruptIds() {
        List<String> ids = new ArrayList<>(List.of("approval-1", "approval-2"));
        SubagentFinishedOutcome suspended = SubagentFinishedOutcome.suspended(ids);
        ids.clear();

        assertEquals(List.of("approval-1", "approval-2"), suspended.interruptIds());
        assertThrows(UnsupportedOperationException.class, () -> suspended.interruptIds().add("approval-3"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "SUCCESS", "interrupt", "failure"})
    void outcomeRejectsTypesOutsideTheSubagentUnion(String type) {
        assertThrows(IllegalArgumentException.class, () -> new SubagentFinishedOutcome(type, null));
    }

    @Test
    void outcomeRequiresAType() {
        assertThrows(NullPointerException.class, () -> new SubagentFinishedOutcome(null, null));
    }

    @Test
    void successRejectsEvenAnEmptyInterruptList() {
        assertThrows(IllegalArgumentException.class, () -> new SubagentFinishedOutcome("success", List.of()));
        assertThrows(IllegalArgumentException.class, () -> new SubagentFinishedOutcome("success", List.of("approval")));
    }

    @Test
    void suspendedRejectsNullInterruptEntries() {
        assertThrows(NullPointerException.class,
                () -> SubagentFinishedOutcome.suspended(Arrays.asList("approval", null)));
    }
}
