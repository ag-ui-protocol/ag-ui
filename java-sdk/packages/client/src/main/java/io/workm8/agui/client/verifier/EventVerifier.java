package io.workm8.agui.client.verifier;

import io.workm8.agui.event.*;
import io.workm8.agui.exception.AGUIException;
import io.workm8.agui.type.EventType;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public class EventVerifier {

    private String activeMessageId;
    private String activeToolCallId;
    private boolean runFinished;
    private boolean runError;
    private boolean firstEventReceived;
    private Map<String, Boolean> activeSteps;
    private boolean activeThinkingStep;
    private boolean activeThinkingStepMessage;

    public EventVerifier() {
        this.activeMessageId = null;
        this.activeToolCallId = null;
        this.runFinished = false;
        this.runError = false;
        this.firstEventReceived = false;
        this.activeSteps = new HashMap<>();
        this.activeThinkingStep = false;
        this.activeThinkingStepMessage = false;
    }

    public void verifyEvent(BaseEvent event) throws AGUIException {
        var eventType = event.getType();

        if (this.runError) {
            throw new AGUIException("Cannot send event type '%s': The run has already errored with 'RUN_ERROR'. No further events can be sent.".formatted(eventType));
        }

        if (runFinished && !eventType.equals(EventType.RUN_ERROR)) {
            throw new AGUIException("Cannot send event type '%s': The run has already finished with 'RUN_FINISHED'. Start a new run with 'RUN_STARTED'.".formatted(eventType));
        }

        if (Objects.nonNull(activeMessageId)) {
            var allowedEventTypes = List.of(
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
                EventType.RAW
            );

            if (!allowedEventTypes.contains(eventType)) {
                throw new AGUIException("Cannot send event type '%s' after 'TEXT_MESSAGE_START': Send 'TEXT_MESSAGE_END' first.".formatted(eventType));
            }
        }

        if (Objects.nonNull(activeToolCallId)) {
            var allowedEventTypes = List.of(
                EventType.TOOL_CALL_ARGS,
                EventType.TOOL_CALL_END,
                EventType.RAW
            );

            if (!allowedEventTypes.contains(eventType)) {
                if (eventType.equals(EventType.TOOL_CALL_START)) {
                    throw new AGUIException("Cannot send 'TOOL_CALL_START' event: A tool call is already in progress. Complete it with 'TOOL_CALL_END' first.");
                }

                throw new AGUIException("Cannot send event type '%s' after 'TOOL_CALL_START': Send 'TOOL_CALL_END' first.".formatted(eventType));
            }
        }

        if (!firstEventReceived) {
            firstEventReceived = true;
            if (!List.of(EventType.RUN_STARTED, EventType.RUN_ERROR).contains(eventType)) {
                throw new AGUIException("First event must be 'RUN_STARTED'");
            }
        } else if (eventType.equals(EventType.RUN_STARTED)) {
            throw new AGUIException("Cannot send multiple 'RUN_STARTED' events: A 'RUN_STARTED' event was already sent. Each run must have exactly one 'RUN_STARTED' event at the beginning.");
        }

        switch (eventType) {
            case TEXT_MESSAGE_START -> {
                if (Objects.nonNull(activeMessageId)) {
                    throw new AGUIException("Cannot send 'TEXT_MESSAGE_START' event: A text message is already in progress. Complete it with 'TEXT_MESSAGE_END' first.");
                }

                activeMessageId = ((TextMessageStartEvent) event).getMessageId();
            }
            case TEXT_MESSAGE_CONTENT -> {
                if (Objects.isNull(activeMessageId)) {
                    throw new AGUIException("Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found. Start a text message with 'TEXT_MESSAGE_START' first.");
                }
                if (!((TextMessageContentEvent) event).getMessageId().equals(activeMessageId)) {
                    throw new AGUIException("Cannot send 'TEXT_MESSAGE_CONTENT' event: Message ID mismatch. The ID '%s' doesn't match the active message ID '%s'".formatted(
                            ((TextMessageContentEvent) event).getMessageId(),
                            activeMessageId
                    ));
                }
            }
            case TEXT_MESSAGE_END -> {
                if (Objects.isNull(activeMessageId)) {
                    throw new AGUIException("Cannot send 'TEXT_MESSAGE_END' event: No active text message found. A 'TEXT_MESSAGE_START' event must be sent first.");
                }
                if (!((TextMessageEndEvent) event).getMessageId().equals(activeMessageId)) {
                    throw new AGUIException("Cannot send 'TEXT_MESSAGE_END' event: Message ID mismatch. The ID '%s' doesn't match the active message ID '%s'.".formatted(
                            ((TextMessageEndEvent) event).getMessageId(),
                            activeMessageId
                    ));
                }

                activeMessageId = null;
            }

            case TOOL_CALL_START -> {
                if (Objects.nonNull(activeToolCallId)) {
                    throw new AGUIException("Cannot send 'TOOL_CALL_START' event: A tool call is already in progress. Complete it with 'TOOL_CALL_END' first.");
                }
                activeToolCallId = ((ToolCallStartEvent) event).getToolCallId();
            }

            case TOOL_CALL_ARGS -> {
                if (Objects.isNull(activeToolCallId)) {
                    throw new AGUIException("Cannot send 'TOOL_CALL_ARGS' event: No active tool call found. Start a tool call with 'TOOL_CALL_START' first.");
                }

                if (!((ToolCallArgsEvent) event).getToolCallId().equals(activeToolCallId)) {
                    throw new AGUIException("Cannot send 'TOOL_CALL_ARGS' event: Tool call ID mismatch. The ID '%s' doesn't match the active tool call ID '%s'.".formatted(
                            ((ToolCallArgsEvent) event).getToolCallId(),
                            activeToolCallId
                    ));
                }
            }

            case TOOL_CALL_END -> {
                if (Objects.isNull(activeToolCallId)) {
                    throw new AGUIException("Cannot send 'TOOL_CALL_END' event. No active tool call found. A 'TOOL_CALL_START' event must be sent first.");
                }

                if (!((ToolCallEndEvent) event).getToolCallId().equals(activeToolCallId)) {
                    throw new AGUIException("Cannot send 'TOOL_CALL_END' event: Tool call ID mismatch. The ID '%s' doesn't match the active tool call ID '%s'.".formatted(
                            ((ToolCallEndEvent) event).getToolCallId(),
                            activeToolCallId
                    ));
                }

                activeToolCallId = null;
            }

            case STEP_STARTED -> {
                var stepName = ((StepStartedEvent) event).getStepName();

                if (activeSteps.containsKey(stepName)) {
                    throw new AGUIException("Step '%s' is already active for 'STEP_STARTED'".formatted(
                            stepName
                    ));
                }

                activeSteps.put(stepName, true);
            }

            case STEP_FINISHED -> {
                var stepName = ((StepFinishedEvent) event).getStepName();
                if (!activeSteps.containsKey(stepName)) {
                    throw new AGUIException("Cannot send 'STEP_FINISHED' for step '%s' that was not started.".formatted(
                            stepName
                    ));
                }
                activeSteps.remove(stepName);
            }

            case RUN_FINISHED -> {
                if (!activeSteps.isEmpty()) {
                    var unfinishedSteps = String.join(", ", activeSteps.keySet());

                    throw new AGUIException("Cannot send 'RUN_FINISHED' while steps are still active: %s.".formatted(
                            unfinishedSteps
                    ));
                }

                runFinished = true;
            }

            case RUN_ERROR -> {
                runError = true;
            }

            case THINKING_TEXT_MESSAGE_START -> {
                if (!activeThinkingStep) {
                    throw new AGUIException("Cannot send 'THINKING_TEXT_MESSAGE_START' event: A thinking step is not in progress. Create one with 'THINKING_START' first.");
                }
                if (activeThinkingStepMessage) {
                    throw new AGUIException("Cannot send 'THINKING_TEXT_MESSAGE_START' event: A thinking message is already in progress. Complete it with 'THINKING_TEXT_MESSAGE_END' first.");
                }
                activeThinkingStepMessage = true;
            }
            case THINKING_TEXT_MESSAGE_CONTENT -> {
                if (!activeThinkingStepMessage) {
                    throw new AGUIException("Cannot send 'THINKING_TEXT_MESSAGE_CONTENT' event: No active thinking message found. Start a message with 'THINKING_TEXT_MESSAGE_START' first.");
                }
            }
            case THINKING_TEXT_MESSAGE_END -> {
                if (!activeThinkingStepMessage) {
                    throw new AGUIException("Cannot send 'THINKING_TEXT_MESSAGE_END' event: No active thinking message found. A 'THINKING_TEXT_MESSAGE_START' event must be sent first.");
                }
                activeThinkingStepMessage = false;
            }
            case THINKING_START -> {
                if (activeThinkingStep) {
                    throw new AGUIException("Cannot send 'THINKING_START' event: A thinking step is already in progress. End it with 'THINKING_END' first.");
                }
                activeThinkingStep = true;
            }
            case THINKING_END -> {
                if (!activeThinkingStep) {
                    throw new AGUIException("Cannot send 'THINKING_END' event: No active thinking step found. A 'THINKING_START' event must be sent first.");
                }
                activeThinkingStep = false;
            }
        }
    }
}

