package com.agui.server;

import com.agui.core.event.*;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("EventFactory")
class EventFactoryTest {

    @Test
    void shouldCreateRunStartedEvent() {
        var threadId = "thread-123";
        var runId = "run-456";

        var event = EventFactory.runStartedEvent(threadId, runId);

        assertThat(event).isInstanceOf(RunStartedEvent.class);
        assertThat(event.getThreadId()).isEqualTo(threadId);
        assertThat(event.getRunId()).isEqualTo(runId);
        assertThat(event.getTimestamp()).isGreaterThan(0);
    }

    @Test
    void shouldCreateTextMessageStartEvent() {
        var messageId = "msg-123";
        var role = "assistant";

        var event = EventFactory.textMessageStartEvent(messageId, role);

        assertThat(event).isInstanceOf(TextMessageStartEvent.class);
        assertThat(event.getMessageId()).isEqualTo(messageId);
        assertThat(event.getRole()).isEqualTo(role);
        assertThat(event.getTimestamp()).isGreaterThan(0);
    }

    @Test
    void shouldCreateTextMessageContentEvent() {
        var messageId = "msg-123";
        var delta = "Hello world";

        var event = EventFactory.textMessageContentEvent(messageId, delta);

        assertThat(event).isInstanceOf(TextMessageContentEvent.class);
        assertThat(event.getMessageId()).isEqualTo(messageId);
        assertThat(event.getDelta()).isEqualTo(delta);
        assertThat(event.getTimestamp()).isGreaterThan(0);
    }

    @Test
    void shouldCreateTextMessageEndEvent() {
        var messageId = "msg-123";

        var event = EventFactory.textMessageEndEvent(messageId);

        assertThat(event).isInstanceOf(TextMessageEndEvent.class);
        assertThat(event.getMessageId()).isEqualTo(messageId);
        assertThat(event.getTimestamp()).isGreaterThan(0);
    }

    @Test
    void shouldCreateRunFinishedEvent() {
        var threadId = "thread-123";
        var runId = "run-456";

        var event = EventFactory.runFinishedEvent(threadId, runId);

        assertThat(event).isInstanceOf(RunFinishedEvent.class);
        assertThat(event.getThreadId()).isEqualTo(threadId);
        assertThat(event.getRunId()).isEqualTo(runId);
        assertThat(event.getTimestamp()).isGreaterThan(0);
    }

    @Test
    void shouldCreateToolCallStartEvent() {
        var messageId = "msg-123";
        var name = "calculate";
        var toolCallId = "call-456";

        var event = EventFactory.toolCallStartEvent(messageId, name, toolCallId);

        assertThat(event).isInstanceOf(ToolCallStartEvent.class);
        assertThat(event.getParentMessageId()).isEqualTo(messageId);
        assertThat(event.getToolCallName()).isEqualTo(name);
        assertThat(event.getToolCallId()).isEqualTo(toolCallId);
        assertThat(event.getTimestamp()).isGreaterThan(0);
    }

    @Test
    void shouldCreateToolCallArgsEvent() {
        var arguments = "{\"x\": 10, \"y\": 20}";
        var toolCallId = "call-456";

        var event = EventFactory.toolCallArgsEvent(arguments, toolCallId);

        assertThat(event).isInstanceOf(ToolCallArgsEvent.class);
        assertThat(event.getDelta()).isEqualTo(arguments);
        assertThat(event.getToolCallId()).isEqualTo(toolCallId);
        assertThat(event.getTimestamp()).isGreaterThan(0);
    }

    @Test
    void shouldCreateToolCallEndEvent() {
        var toolCallId = "call-456";

        var event = EventFactory.toolCallEndEvent(toolCallId);

        assertThat(event).isInstanceOf(ToolCallEndEvent.class);
        assertThat(event.getToolCallId()).isEqualTo(toolCallId);
        assertThat(event.getTimestamp()).isGreaterThan(0);
    }

    @Test
    void shouldCreateRunErrorEvent() {
        var errorMessage = "Something went wrong";

        var event = EventFactory.runErrorEvent(errorMessage);

        assertThat(event).isInstanceOf(RunErrorEvent.class);
        assertThat(event.getError()).isEqualTo(errorMessage);
        assertThat(event.getTimestamp()).isGreaterThan(0);
    }

    @Test
    void shouldHavePrivateConstructor() {
        // Verify the class cannot be instantiated
        assertThat(EventFactory.class.getDeclaredConstructors()).hasSize(1);
        assertThat(EventFactory.class.getDeclaredConstructors()[0].getModifiers() & 0x00000002).isEqualTo(2); // Private modifier
    }
}