package com.agui.chatapp.java.adapter;

import com.agui.core.types.*;

/**
 * Utility class for processing AG-UI events in Java.
 * Provides type-safe event handling and conversion utilities.
 */
public class EventProcessor {
    
    /**
     * Interface for handling different event types
     */
    public interface EventHandler {
        void onRunStarted(RunStartedEvent event);
        void onRunFinished(RunFinishedEvent event);
        void onRunError(RunErrorEvent event);
        void onStepStarted(StepStartedEvent event);
        void onStepFinished(StepFinishedEvent event);
        void onTextMessageStart(TextMessageStartEvent event);
        void onTextMessageContent(TextMessageContentEvent event);
        void onTextMessageEnd(TextMessageEndEvent event);
        void onToolCallStart(ToolCallStartEvent event);
        void onToolCallArgs(ToolCallArgsEvent event);
        void onToolCallEnd(ToolCallEndEvent event);
        void onStateSnapshot(StateSnapshotEvent event);
        void onStateDelta(StateDeltaEvent event);
        void onMessagesSnapshot(MessagesSnapshotEvent event);
        void onRawEvent(RawEvent event);
        void onCustomEvent(CustomEvent event);
        void onUnknownEvent(BaseEvent event);
    }
    
    /**
     * Process an event using the provided handler
     * @param event The event to process
     * @param handler The handler to use for processing
     */
    public static void processEvent(BaseEvent event, EventHandler handler) {
        if (event instanceof RunStartedEvent) {
            handler.onRunStarted((RunStartedEvent) event);
        } else if (event instanceof RunFinishedEvent) {
            handler.onRunFinished((RunFinishedEvent) event);
        } else if (event instanceof RunErrorEvent) {
            handler.onRunError((RunErrorEvent) event);
        } else if (event instanceof StepStartedEvent) {
            handler.onStepStarted((StepStartedEvent) event);
        } else if (event instanceof StepFinishedEvent) {
            handler.onStepFinished((StepFinishedEvent) event);
        } else if (event instanceof TextMessageStartEvent) {
            handler.onTextMessageStart((TextMessageStartEvent) event);
        } else if (event instanceof TextMessageContentEvent) {
            handler.onTextMessageContent((TextMessageContentEvent) event);
        } else if (event instanceof TextMessageEndEvent) {
            handler.onTextMessageEnd((TextMessageEndEvent) event);
        } else if (event instanceof ToolCallStartEvent) {
            handler.onToolCallStart((ToolCallStartEvent) event);
        } else if (event instanceof ToolCallArgsEvent) {
            handler.onToolCallArgs((ToolCallArgsEvent) event);
        } else if (event instanceof ToolCallEndEvent) {
            handler.onToolCallEnd((ToolCallEndEvent) event);
        } else if (event instanceof StateSnapshotEvent) {
            handler.onStateSnapshot((StateSnapshotEvent) event);
        } else if (event instanceof StateDeltaEvent) {
            handler.onStateDelta((StateDeltaEvent) event);
        } else if (event instanceof MessagesSnapshotEvent) {
            handler.onMessagesSnapshot((MessagesSnapshotEvent) event);
        } else if (event instanceof RawEvent) {
            handler.onRawEvent((RawEvent) event);
        } else if (event instanceof CustomEvent) {
            handler.onCustomEvent((CustomEvent) event);
        } else {
            handler.onUnknownEvent(event);
        }
    }
    
    /**
     * Check if an event is a text message event
     * @param event The event to check
     * @return true if the event is related to text messages
     */
    public static boolean isTextMessageEvent(BaseEvent event) {
        return event instanceof TextMessageStartEvent ||
               event instanceof TextMessageContentEvent ||
               event instanceof TextMessageEndEvent;
    }
    
    /**
     * Check if an event is a tool call event
     * @param event The event to check
     * @return true if the event is related to tool calls
     */
    public static boolean isToolCallEvent(BaseEvent event) {
        return event instanceof ToolCallStartEvent ||
               event instanceof ToolCallArgsEvent ||
               event instanceof ToolCallEndEvent;
    }
    
    /**
     * Check if an event is a lifecycle event
     * @param event The event to check
     * @return true if the event is a lifecycle event
     */
    public static boolean isLifecycleEvent(BaseEvent event) {
        return event instanceof RunStartedEvent ||
               event instanceof RunFinishedEvent ||
               event instanceof RunErrorEvent ||
               event instanceof StepStartedEvent ||
               event instanceof StepFinishedEvent;
    }
    
    /**
     * Check if an event is a state management event
     * @param event The event to check
     * @return true if the event is related to state management
     */
    public static boolean isStateEvent(BaseEvent event) {
        return event instanceof StateSnapshotEvent ||
               event instanceof StateDeltaEvent ||
               event instanceof MessagesSnapshotEvent;
    }
    
    /**
     * Get a human-readable description of the event type
     * @param event The event to describe
     * @return A human-readable description
     */
    public static String getEventDescription(BaseEvent event) {
        if (event instanceof RunStartedEvent) return "Run Started";
        if (event instanceof RunFinishedEvent) return "Run Finished";
        if (event instanceof RunErrorEvent) return "Run Error";
        if (event instanceof StepStartedEvent) return "Step Started";
        if (event instanceof StepFinishedEvent) return "Step Finished";
        if (event instanceof TextMessageStartEvent) return "Text Message Start";
        if (event instanceof TextMessageContentEvent) return "Text Message Content";
        if (event instanceof TextMessageEndEvent) return "Text Message End";
        if (event instanceof ToolCallStartEvent) return "Tool Call Start";
        if (event instanceof ToolCallArgsEvent) return "Tool Call Args";
        if (event instanceof ToolCallEndEvent) return "Tool Call End";
        if (event instanceof StateSnapshotEvent) return "State Snapshot";
        if (event instanceof StateDeltaEvent) return "State Delta";
        if (event instanceof MessagesSnapshotEvent) return "Messages Snapshot";
        if (event instanceof RawEvent) return "Raw Event";
        if (event instanceof CustomEvent) return "Custom Event";
        return "Unknown Event";
    }
}