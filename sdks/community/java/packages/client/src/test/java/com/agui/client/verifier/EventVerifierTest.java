package com.agui.client.verifier;

import com.agui.core.event.*;
import com.agui.core.exception.AGUIException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThatExceptionOfType;

@DisplayName("EventVerifier")
class EventVerifierTest {

    @Test
    void itShouldStartRunEvent() throws AGUIException {
        var event = new RunStartedEvent();

        var verifier = new EventVerifier();

        verifier.verifyEvent(event);
    }

    @Test
    void itShouldThrowExceptionWhenFirstEventIsNotStart() {
        var event = new CustomEvent();

        var verifier = new EventVerifier();
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(event))
                .withMessage("First event must be 'RUN_STARTED'");
    }

    @Test
    void itShouldThrowExceptionWhenEventSentAfterRunFinished() throws AGUIException {
        var start = new RunStartedEvent();
        var finish = new RunFinishedEvent();
        var custom = new CustomEvent();

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(finish);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(custom))
                .withMessage("Cannot send event type 'CUSTOM': The run has already finished with 'RUN_FINISHED'. Start a new run with 'RUN_STARTED'.");
    }

    @Test
    void itShouldThrowExceptionWhenEventSentAfterRunError() throws AGUIException {
        var start = new RunStartedEvent();
        var error = new RunErrorEvent();
        var custom = new CustomEvent();

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(error);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(custom))
                .withMessage("Cannot send event type 'CUSTOM': The run has already errored with 'RUN_ERROR'. No further events can be sent.");
    }

    @Test
    void sendMultipleToolCallStartEvents() throws AGUIException {
        var start = new RunStartedEvent();
        var toolCallId = UUID.randomUUID().toString();

        var toolCallStart = new ToolCallStartEvent();
        toolCallStart.setToolCallId(toolCallId);

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(toolCallStart);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(toolCallStart))
                .withMessage("Cannot send 'TOOL_CALL_START' event: A tool call is already in progress. Complete it with 'TOOL_CALL_END' first.");
    }

    @Test
    void sendMultipleTextEventStartedEvents() throws AGUIException {
        var start = new RunStartedEvent();
        var event = new TextMessageStartEvent();
        var id = UUID.randomUUID().toString();
        event.setMessageId(id);

        var verifier = new EventVerifier();
        verifier.verifyEvent(start);
        verifier.verifyEvent(event);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(event))
                .withMessage("Cannot send event type 'TEXT_MESSAGE_START' after 'TEXT_MESSAGE_START': Send 'TEXT_MESSAGE_END' first.");
    }

    @Test
    void sendTextMessageEndWithUnknownMessageIdShouldThrowError() throws AGUIException {
        var start = new RunStartedEvent();
        var event = new TextMessageEndEvent();
        var id = UUID.randomUUID().toString();

        event.setMessageId(id);

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(event))
                .withMessage("Cannot send 'TEXT_MESSAGE_END' event: No active text message found. A 'TEXT_MESSAGE_START' event must be sent first.");
    }

    @Test
    void endingUnknownTextMessageShouldThrowError() throws AGUIException {
        var start = new RunStartedEvent();
        var firstId = UUID.randomUUID().toString();
        var secondId = UUID.randomUUID().toString();
        var textStart = new TextMessageStartEvent();
        var textEnd = new TextMessageEndEvent();

        textStart.setMessageId(firstId);
        textEnd.setMessageId(secondId);

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(textStart);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(textEnd))
                .withMessage("Cannot send 'TEXT_MESSAGE_END' event: Message ID mismatch. The ID '%s' doesn't match the active message ID '%s'.".formatted(
                        secondId,
                        firstId
                ));
    }

    @Test
    void sendingMultipleToolCallStartEventsShouldThrowError() throws AGUIException {
        var start = new RunStartedEvent();
        var event = new ToolCallStartEvent();
        var id = UUID.randomUUID().toString();

        event.setToolCallId(id);

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(event);

        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(event))
                .withMessage("Cannot send 'TOOL_CALL_START' event: A tool call is already in progress. Complete it with 'TOOL_CALL_END' first.");
    }

    @Test
    void toolCallArgsEventShouldThrowErrorOnNoActiveToolCall() throws AGUIException {
        var start = new RunStartedEvent();
        var event = new ToolCallArgsEvent();
        var id = UUID.randomUUID().toString();

        event.setToolCallId(id);

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(event))
                .withMessage("Cannot send 'TOOL_CALL_ARGS' event: No active tool call found. Start a tool call with 'TOOL_CALL_START' first.");
    }

    @Test
    void unknownToolCallArgsEventShouldThrowError() throws AGUIException {
        var start = new RunStartedEvent();
        var toolStart = new ToolCallStartEvent();
        var event = new ToolCallArgsEvent();
        var firstId = UUID.randomUUID().toString();
        var secondId = UUID.randomUUID().toString();

        toolStart.setToolCallId(firstId);
        event.setToolCallId(secondId);

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(toolStart);

        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(event))
                .withMessage("Cannot send 'TOOL_CALL_ARGS' event: Tool call ID mismatch. The ID '%s' doesn't match the active tool call ID '%s'.".formatted(
                        secondId,
                        firstId
                ));
    }

    @Test
    void toolCallEndOnNoActiveToolCallsShouldThrowError() throws AGUIException {
        var start = new RunStartedEvent();
        var event = new ToolCallEndEvent();
        var id = UUID.randomUUID().toString();

        event.setToolCallId(id);

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(event))
                .withMessage("Cannot send 'TOOL_CALL_END' event. No active tool call found. A 'TOOL_CALL_START' event must be sent first.");
    }

    @Test
    void unknownToolCallEndEventShouldThrowError() throws AGUIException {
        var start = new RunStartedEvent();
        var toolStart = new ToolCallStartEvent();
        var event = new ToolCallEndEvent();
        var firstId = UUID.randomUUID().toString();
        var secondId = UUID.randomUUID().toString();

        toolStart.setToolCallId(firstId);
        event.setToolCallId(secondId);

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(toolStart);

        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(event))
                .withMessage("Cannot send 'TOOL_CALL_END' event: Tool call ID mismatch. The ID '%s' doesn't match the active tool call ID '%s'.".formatted(
                        secondId,
                        firstId
                ));
    }

    @Test
    void startStepTwiceShouldThrowError() throws AGUIException {
        var start = new RunStartedEvent();
        var event = new StepStartedEvent();
        var stepName = "STEP";

        event.setStepName(stepName);

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(event);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(event))
                .withMessage("Step '%s' is already active for 'STEP_STARTED'".formatted(stepName));
    }

    @Test
    void finishUnknownStepShouldThrowError() throws AGUIException {
        var start = new RunStartedEvent();
        var event = new StepStartedEvent();
        var finish = new StepFinishedEvent();

        var stepName = "STEP";

        event.setStepName(stepName);

        finish.setStepName("OTHER");

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(event);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(finish))
                .withMessage("Cannot send 'STEP_FINISHED' for step 'OTHER' that was not started.");
    }

    @Test
    void runFinishedEventOnActiveStepsShouldThrowError() throws AGUIException {
        var start = new RunStartedEvent();
        var event = new StepStartedEvent();
        var finish = new RunFinishedEvent();

        var stepName = "STEP";

        event.setStepName(stepName);

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(event);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(finish))
                .withMessage("Cannot send 'RUN_FINISHED' while steps are still active: %s.".formatted(stepName));
    }

    @Test
    void thinkingTextMessageStartShouldThrowErrorWhenNotStarted() throws AGUIException {
        var start = new RunStartedEvent();

        var event = new ThinkingTextMessageStartEvent();

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(event))
                .withMessage("Cannot send 'THINKING_TEXT_MESSAGE_START' event: A thinking step is not in progress. Create one with 'THINKING_START' first.");
    }

    @Test
    void thinkingTextMessageStartShouldThrowErrorWhenAlreadyStarted() throws AGUIException {
        var start = new RunStartedEvent();
        var thinkStart = new ThinkingStartEvent();
        var event = new ThinkingTextMessageStartEvent();

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(thinkStart);
        verifier.verifyEvent(event);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(event))
                .withMessage("Cannot send 'THINKING_TEXT_MESSAGE_START' event: A thinking message is already in progress. Complete it with 'THINKING_TEXT_MESSAGE_END' first.");
    }

    @Test
    void thinkingTextMessageContentShouldThrowErrorWhenNoActiveMessage() throws AGUIException {
        var start = new RunStartedEvent();
        var thinkStart = new ThinkingStartEvent();
        var contentEvent = new ThinkingTextMessageContentEvent();

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(thinkStart);

        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(contentEvent))
                .withMessage("Cannot send 'THINKING_TEXT_MESSAGE_CONTENT' event: No active thinking message found. Start a message with 'THINKING_TEXT_MESSAGE_START' first.");
    }

    @Test
    void thinkingTextMessageEndShouldThrowErrorWhenNoActiveMessage() throws AGUIException {
        var start = new RunStartedEvent();
        var thinkStart = new ThinkingStartEvent();
        var messageEnd = new ThinkingTextMessageEndEvent();

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(thinkStart);

        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(messageEnd))
                .withMessage("Cannot send 'THINKING_TEXT_MESSAGE_END' event: No active thinking message found. A 'THINKING_TEXT_MESSAGE_START' event must be sent first.");
    }

    @Test
    void thinkingStartShouldThrowErrorWhenAlreadyStarted() throws AGUIException {
        var start = new RunStartedEvent();
        var thinkStart1 = new ThinkingStartEvent();
        var thinkStart2 = new ThinkingStartEvent();

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);
        verifier.verifyEvent(thinkStart1);

        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(thinkStart2))
                .withMessage("Cannot send 'THINKING_START' event: A thinking step is already in progress. End it with 'THINKING_END' first.");
    }

    @Test
    void thinkingEndShouldThrowErrorWhenNoActiveThinkingStep() throws AGUIException {
        var start = new RunStartedEvent();
        var thinkEnd = new ThinkingEndEvent();

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);

        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(thinkEnd))
                .withMessage("Cannot send 'THINKING_END' event: No active thinking step found. A 'THINKING_START' event must be sent first.");
    }

    @Test
    void thinkingTextMessageStartShouldThrowErrorWhenNoActiveThinkingStep() throws AGUIException {
        var start = new RunStartedEvent();
        var messageStart = new ThinkingTextMessageStartEvent();

        var verifier = new EventVerifier();

        verifier.verifyEvent(start);

        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(messageStart))
                .withMessage("Cannot send 'THINKING_TEXT_MESSAGE_START' event: A thinking step is not in progress. Create one with 'THINKING_START' first.");
    }

    @Test
    void itShouldThrowExceptionOnRunTwice() throws AGUIException {
        var event = new RunStartedEvent();

        var verifier = new EventVerifier();

        verifier.verifyEvent(event);
        assertThatExceptionOfType(AGUIException.class)
                .isThrownBy(() -> verifier.verifyEvent(event))
                .withMessage("Cannot send multiple 'RUN_STARTED' events: A 'RUN_STARTED' event was already sent. Each run must have exactly one 'RUN_STARTED' event at the beginning.");
    }

}