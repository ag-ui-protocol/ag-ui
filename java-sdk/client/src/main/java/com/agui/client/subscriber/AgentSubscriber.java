package com.agui.client.subscriber;

import com.agui.client.ToolCall;
import com.agui.event.*;
import com.agui.message.BaseMessage;

import java.util.concurrent.CompletableFuture;

public interface AgentSubscriber {

    // Request lifecycle
    default CompletableFuture<AgentStateMutation> onRunInitialized(
            AgentSubscriberParams params) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onRunFailed(
            AgentSubscriberParams params,
            Exception error) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onRunFinalized(
            AgentSubscriberParams params) {
        return CompletableFuture.completedFuture(null);
    }

    // Events
    default CompletableFuture<AgentStateMutation> onEvent(
        AgentSubscriberParams params,
        BaseEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onRunStartedEvent(
        AgentSubscriberParams params,
        RunStartedEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onRunFinishedEvent(
            AgentSubscriberParams params,
            RunFinishedEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onRunErrorEvent(
            AgentSubscriberParams params,
            RunErrorEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onStepStartedEvent(
            AgentSubscriberParams params,
            StepStartedEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onStepFinishedEvent(
            AgentSubscriberParams params,
            StepFinishedEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onTextMessageStartEvent(
            AgentSubscriberParams params,
            TextMessageStartEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onTextMessageContentEvent(
            AgentSubscriberParams params,
            TextMessageContentEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onTextMessageEndEvent(
            AgentSubscriberParams params,
            TextMessageEndEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onToolCallStartEvent(
            AgentSubscriberParams params,
            ToolCallStartEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onToolCallArgsEvent(
            AgentSubscriberParams params,
            ToolCallArgsEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onToolCallEndEvent(
        AgentSubscriberParams params,
        ToolCallEndEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onToolCallResultEvent(
        AgentSubscriberParams params,
        ToolCallResultEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onStateSnapshotEvent(
            AgentSubscriberParams params,
            StateSnapshotEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onStateDeltaEvent(
        AgentSubscriberParams params,
        StateDeltaEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onMessagesSnapshotEvent(
        AgentSubscriberParams params,
        MessagesSnapshotEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onRawEvent(
        AgentSubscriberParams params,
        RawEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<AgentStateMutation> onCustomEvent(
        AgentSubscriberParams params,
        CustomEvent event
    ) {
        return CompletableFuture.completedFuture(null);
    }

    // State changes

    default CompletableFuture<Void> onMessagesChanged(
        AgentSubscriberParams params
    ) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletableFuture<Void> onStateChanged(
        AgentSubscriberParams params
    ) {
        return CompletableFuture.completedFuture(null);
    }


    default CompletableFuture<Void> onNewMessage(
        AgentSubscriberParams params,
        BaseMessage message
    ) {
        return CompletableFuture.completedFuture(null);
    }


    default CompletableFuture<Void> onNewToolCall(
        AgentSubscriberParams params,
        ToolCall toolCall
    ) {
        return CompletableFuture.completedFuture(null);
    }
}

