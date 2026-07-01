package com.agui.community.core.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.agui.community.core.message.Message;
import com.agui.community.core.message.UserMessage;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class RunAgentInputTest {

    @Test
    void nullCollectionsDefaultToEmpty() {
        RunAgentInput input = new RunAgentInput("t1", "r1", null, null, null, null, null);
        assertTrue(input.messages().isEmpty());
        assertTrue(input.tools().isEmpty());
        assertTrue(input.context().isEmpty());
    }

    @Test
    void requiresThreadAndRunId() {
        assertThrows(NullPointerException.class,
                () -> new RunAgentInput(null, "r1", List.of(), List.of()));
        assertThrows(NullPointerException.class,
                () -> new RunAgentInput("t1", null, List.of(), List.of()));
    }

    @Test
    void messagesAreCopiedAndUnmodifiable() {
        List<Message> messages = new ArrayList<>();
        messages.add(new UserMessage("m1", "hi"));

        RunAgentInput input = new RunAgentInput("t1", "r1", messages, List.of());
        messages.clear();

        assertEquals(1, input.messages().size());
        assertThrows(UnsupportedOperationException.class,
                () -> input.messages().add(new UserMessage("m2", "yo")));
    }

    @Test
    void contextRequiresDescriptionAndValue() {
        assertThrows(NullPointerException.class, () -> new Context(null, "v"));
        assertThrows(NullPointerException.class, () -> new Context("d", null));
    }
}
