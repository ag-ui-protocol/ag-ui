package com.agui.core.agent;

import com.agui.core.event.*;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThatNoException;


@DisplayName("AgentSubscriber")
class AgentSubscriberTest {

    @Test
    void shouldHaveDefaultMethods() {
        var sut = new AgentSubscriber() {
        };

        assertThatNoException().isThrownBy(() -> sut.onRunInitialized(null));
        assertThatNoException().isThrownBy(() -> sut.onRunFinalized(null));
        assertThatNoException().isThrownBy(() -> sut.onRunFailed(null, null));

        assertThatNoException().isThrownBy(() -> sut.onEvent(new CustomEvent()));
        assertThatNoException().isThrownBy(() -> sut.onCustomEvent(new CustomEvent()));
        assertThatNoException().isThrownBy(() -> sut.onRawEvent(new RawEvent()));

        assertThatNoException().isThrownBy(() -> sut.onRunStartedEvent(new RunStartedEvent()));
        assertThatNoException().isThrownBy(() -> sut.onRunFinishedEvent(new RunFinishedEvent()));
        assertThatNoException().isThrownBy(() -> sut.onRunErrorEvent(new RunErrorEvent()));

        assertThatNoException().isThrownBy(() -> sut.onStepStartedEvent(new StepStartedEvent()));
        assertThatNoException().isThrownBy(() -> sut.onStepFinishedEvent(new StepFinishedEvent()));

        assertThatNoException().isThrownBy(() -> sut.onTextMessageStartEvent(new TextMessageStartEvent()));
        assertThatNoException().isThrownBy(() -> sut.onTextMessageContentEvent(new TextMessageContentEvent()));
        assertThatNoException().isThrownBy(() -> sut.onTextMessageEndEvent(new TextMessageEndEvent()));

        assertThatNoException().isThrownBy(() -> sut.onToolCallStartEvent(new ToolCallStartEvent()));
        assertThatNoException().isThrownBy(() -> sut.onToolCallArgsEvent(new ToolCallArgsEvent()));
        assertThatNoException().isThrownBy(() -> sut.onToolCallEndEvent(new ToolCallEndEvent()));

        assertThatNoException().isThrownBy(() -> sut.onToolCallResultEvent(new ToolCallResultEvent()));

        assertThatNoException().isThrownBy(() -> sut.onStateSnapshotEvent(new StateSnapshotEvent()));
        assertThatNoException().isThrownBy(() -> sut.onStateDeltaEvent(new StateDeltaEvent()));
        assertThatNoException().isThrownBy(() -> sut.onMessagesSnapshotEvent(new MessagesSnapshotEvent()));

        assertThatNoException().isThrownBy(() -> sut.onMessagesChanged(null));
        assertThatNoException().isThrownBy(() -> sut.onStateChanged(null));
        assertThatNoException().isThrownBy(() -> sut.onNewMessage(null));
        assertThatNoException().isThrownBy(() -> sut.onNewToolCall(null));
    }
}