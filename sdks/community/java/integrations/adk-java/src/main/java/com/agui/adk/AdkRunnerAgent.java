package com.agui.adk;

import com.agui.core.agent.Agent;
import com.agui.core.agent.AgentSubscriber;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.*;
import com.agui.core.message.BaseMessage;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

import com.google.adk.agents.RunConfig;
import com.google.adk.events.Event;
import com.google.adk.runner.Runner;
import com.google.genai.types.Content;
import com.google.genai.types.Part;
import io.reactivex.rxjava3.core.Flowable;

import static com.agui.server.EventFactory.*;


/**
 * A concrete implementation of {@link Agent} that integrates with Spring AI framework
 * to provide AI-powered agent capabilities.
 *
 * This agent leverages Spring AI's ChatClient to process messages and interact with
 * various chat models. It supports tools, advisors, chat memory, and streaming responses.
 * The agent handles the complete lifecycle of chat interactions including tool calls,
 * memory management, and event emission for real-time updates.
 *
 * Key features:
 * <ul>
 * <li>Integration with Spring AI ChatClient and ChatModel</li>
 * <li>Support for tool callbacks and function calling</li>
 * <li>Chat memory management for conversation persistence</li>
 * <li>Advisor pattern support for extending functionality</li>
 * <li>Streaming response handling with real-time events</li>
 * <li>Automatic tool mapping from AG-UI tools to Spring AI tools</li>
 * </ul>
 *
 * @author Pascal Wilbrink
 * @since 1.0
 */
public class AdkRunnerAgent implements Agent {

    private final Runner runner;
    private final String userId;
    private final String sessionId;
    private final Content content;
    private final RunConfig runConfig;


    public AdkRunnerAgent(Runner runner, String userId, String sessionId,
                          Content content, RunConfig runConfig)  {
        this.runner = runner;
        this.userId = userId;
        this.sessionId = sessionId;
        this.content = content;
        this.runConfig = runConfig;
    }

    @Override
    public CompletableFuture<Void> runAgent(RunAgentParameters parameters, AgentSubscriber subscriber) {
        CompletableFuture<Void> future = new CompletableFuture<>();
        String threadId = parameters.getThreadId();
        String runId = parameters.getRunId() != null ? parameters.getRunId() : UUID.randomUUID().toString();
        String messageId = UUID.randomUUID().toString();

        // Emit the mandatory lifecycle events to prepare the UI.
        emitEvent(runStartedEvent(threadId, runId), subscriber);
        emitEvent(textMessageStartEvent(messageId, "assistant"), subscriber);

        Flowable<Event> eventFlowable = runner.runAsync(userId, sessionId, content, runConfig);

        eventFlowable.subscribe(
            event -> {
                // Check if the event from ADK contains a text part from the model.
                Part textPart = findTextPart(event);
                if (textPart != null) {
                    // If it's text, map it to the AG-UI TEXT_MESSAGE_CONTENT event.
                    // The findTextPart method guarantees the optional is present.
                    emitEvent(textMessageContentEvent(messageId, textPart.text().get()), subscriber);
                } else {
                    // For other event types (like tool calls), wrap them in a RawEvent for now.
                    var rawEvent = new RawEvent();
                    rawEvent.setRawEvent(event);
                    emitEvent(rawEvent, subscriber);
                }
            },
            error -> {
                // On error, emit a RUN_ERROR event and notify both the subscriber and the future.
                emitEvent(runErrorEvent(error.getMessage()), subscriber);
                subscriber.onRunFailed(null, error);
                future.completeExceptionally(error);
            },
            () -> {
                // On successful completion, emit the final lifecycle events.
                emitEvent(textMessageEndEvent(messageId), subscriber);
                emitEvent(runFinishedEvent(threadId, runId), subscriber);
                // Then notify both the subscriber and the future that the run is complete.
                subscriber.onRunFinalized(null);
                future.complete(null);
            }
        );

        return future;
    }

    private Part findTextPart(Event event) {
        Optional<Content> contentOptional = event.content();
        if (contentOptional.isEmpty()) {
            return null;
        }
        Content content = contentOptional.get();

        if (content.role().isEmpty() || !"model".equals(content.role().get())) {
            return null;
        }

        Optional<List<Part>> partsOptional = content.parts();
        if (partsOptional.isEmpty() || partsOptional.get().isEmpty()) {
            return null;
        }
        List<Part> parts = partsOptional.get();

        return parts.stream()
            .filter(part -> part.text().isPresent() && !part.text().get().isEmpty())
            .findFirst()
            .orElse(null);
    }


    @Override
    public List<BaseMessage> getMessages() {
        return List.of();
    }

    protected void emitEvent(final BaseEvent event, final AgentSubscriber subscriber) {
        subscriber.onEvent(event);

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
                var chunkEvent = (TextMessageChunkEvent)event;
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