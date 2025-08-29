package com.agui.client.subscriber;

import com.agui.event.*;
import com.agui.message.BaseMessage;
import com.agui.types.ToolCall;

public interface AgentSubscriber {

    // Request lifecycle
    default void onRunInitialized(AgentSubscriberParams params) { }
    default void onRunFailed(AgentSubscriberParams params, Throwable error) { }
    default void onRunFinalized(AgentSubscriberParams params) { }

    // Events
    default void onEvent(BaseEvent event) { }
    default void onRunStartedEvent(RunStartedEvent event) { }
    default void onRunFinishedEvent(RunFinishedEvent event) { }
    default void onRunErrorEvent(RunErrorEvent event) { }
    default void onStepStartedEvent(StepStartedEvent event) { }
    default void onStepFinishedEvent(StepFinishedEvent event) { }
    default void onTextMessageStartEvent(TextMessageStartEvent event) { }
    default void onTextMessageContentEvent(TextMessageContentEvent event) { }
    default void onTextMessageEndEvent(TextMessageEndEvent event) { }
    default void onToolCallStartEvent(ToolCallStartEvent event) { }
    default void onToolCallArgsEvent(ToolCallArgsEvent event) { }
    default void onToolCallEndEvent(ToolCallEndEvent event) { }
    default void onToolCallResultEvent(ToolCallResultEvent event) { }
    default void onStateSnapshotEvent(StateSnapshotEvent event) { }
    default void onStateDeltaEvent(StateDeltaEvent event) { }
    default void onMessagesSnapshotEvent(MessagesSnapshotEvent event) { }
    default void onRawEvent(RawEvent event) { }
    default void onCustomEvent(CustomEvent event) { }

    // State changes
    default void onMessagesChanged(AgentSubscriberParams params) { }
    default void onStateChanged(AgentSubscriberParams params) { }
    default void onNewMessage(BaseMessage message) { }
    default void onNewToolCall(ToolCall toolCall) { }

}

