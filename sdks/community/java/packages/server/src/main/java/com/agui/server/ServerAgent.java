package com.agui.server;

import com.agui.core.agent.Agent;
import com.agui.core.agent.AgentSubscriber;
import com.agui.core.event.*;

/**
 * An abstract base class for all agents designed to run in the AG-UI server environment.
 *
 * This class provides common, shared functionality for all server-side agents,
 * most importantly a consistent mechanism for dispatching events to a subscriber.
 */
public abstract class ServerAgent implements Agent {

    /**
     * Emits an event to the subscriber and routes it to the appropriate specific event handler
     * based on the event type. This method contains the centralized dispatch logic.
     *
     * @param event the event to emit
     * @param subscriber the subscriber to notify of the event
     */
    protected void emitEvent(final BaseEvent event, final AgentSubscriber subscriber) {
        // Always call the generic onEvent handler first
        subscriber.onEvent(event);

        // Dispatch to the specific, typed handler
        switch (event.getType()) {
            case RAW -> subscriber.onRawEvent((RawEvent) event);
            case CUSTOM -> subscriber.onCustomEvent((CustomEvent) event);
            case RUN_STARTED -> subscriber.onRunStartedEvent((RunStartedEvent) event);
            case RUN_ERROR -> subscriber.onRunErrorEvent((RunErrorEvent) event);
            case RUN_FINISHED -> subscriber.onRunFinishedEvent((RunFinishedEvent) event);
            case STEP_STARTED -> subscriber.onStepStartedEvent((StepStartedEvent) event);
            case STEP_FINISHED -> subscriber.onStepFinishedEvent((StepFinishedEvent) event);
            case TEXT_MESSAGE_START -> subscriber.onTextMessageStartEvent((TextMessageStartEvent) event);
            case TEXT_MESSAGE_CHUNK -> {
                // Compatibility: Convert Chunk event to the standard Content event
                var chunkEvent = (TextMessageChunkEvent) event;
                var textMessageContentEvent = new TextMessageContentEvent();
                textMessageContentEvent.setDelta(chunkEvent.getDelta());
                textMessageContentEvent.setMessageId(chunkEvent.getMessageId());
                textMessageContentEvent.setTimestamp(chunkEvent.getTimestamp());
                textMessageContentEvent.setRawEvent(chunkEvent.getRawEvent());
                subscriber.onTextMessageContentEvent(textMessageContentEvent);
            }
            case TEXT_MESSAGE_CONTENT -> subscriber.onTextMessageContentEvent((TextMessageContentEvent) event);
            case TEXT_MESSAGE_END -> subscriber.onTextMessageEndEvent((TextMessageEndEvent) event);
            case TOOL_CALL_START -> subscriber.onToolCallStartEvent((ToolCallStartEvent) event);
            case TOOL_CALL_ARGS -> subscriber.onToolCallArgsEvent((ToolCallArgsEvent) event);
            case TOOL_CALL_RESULT -> subscriber.onToolCallResultEvent((ToolCallResultEvent) event);
            case TOOL_CALL_END -> subscriber.onToolCallEndEvent((ToolCallEndEvent) event);
        }
    }
}
