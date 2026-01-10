package com.agui.adk;

import com.agui.adk.processor.MessageChunk;
import com.agui.adk.processor.MessageProcessor;
import com.agui.adk.processor.ToolResult;
import com.agui.adk.translator.EventTranslator;
import com.agui.adk.translator.EventTranslatorFactory;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.BaseEvent;
import com.agui.core.message.AssistantMessage;
import com.agui.core.message.BaseMessage;
import com.agui.core.tool.ToolCall;
import com.google.adk.agents.RunConfig;
import com.google.adk.runner.Runner;
import com.google.adk.sessions.Session;
import io.reactivex.rxjava3.core.Flowable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;
import java.util.function.Function;
import java.util.stream.Collectors;

import static com.agui.server.EventFactory.*;

public final class AguiAdkRunnerAdapter {

    private static final Logger logger = LoggerFactory.getLogger(AguiAdkRunnerAdapter.class);

    private final Runner runner;
    private final SessionManager sessionManager;
    private final RunConfig runConfig;
    private final Function<RunAgentParameters, String> userIdExtractor;
    private final EventTranslatorFactory eventTranslatorFactory;
    private final MessageProcessor messageProcessor;


    public AguiAdkRunnerAdapter(
            Runner runner,
            SessionManager sessionManager,
            RunConfig runConfig,
            Function<RunAgentParameters, String> userIdExtractor
    ) {
        // Simplified constructor
        this(runner, sessionManager, runConfig, userIdExtractor, EventTranslatorFactory.INSTANCE, MessageProcessor.INSTANCE);
    }

    AguiAdkRunnerAdapter( // Full constructor
                          Runner runner,
                          SessionManager sessionManager,
                          RunConfig runConfig,
                          Function<RunAgentParameters, String> userIdExtractor,
                          EventTranslatorFactory eventTranslatorFactory,
                          MessageProcessor messageProcessor
    ) {
        this.runner = runner;
        this.sessionManager = sessionManager;
        this.runConfig = runConfig;
        this.userIdExtractor = userIdExtractor;
        this.eventTranslatorFactory = eventTranslatorFactory;
        this.messageProcessor = messageProcessor;
    }

    public Flowable<BaseEvent> runAgent(RunAgentParameters parameters) {
        return Flowable.defer(() -> {
            try {
                RunContext runContext = new RunContext(parameters, this.runner.appName(), userIdExtractor.apply(parameters));

                Flowable<BaseEvent> coreLogic = sessionManager.getSessionAndProcessedMessageIds(runContext)
                        .toFlowable()
                        .doOnError(ex -> logger.error("Failed to get session and processed message IDs for appName '{}'", runContext.appName(), ex))
                        .flatMap(sessionData -> processUnseenMessages(runContext, parameters, sessionData.processedIds(), sessionData.session()));

                return Flowable.<BaseEvent>just(runStartedEvent(runContext.sessionId(), runContext.runId()))
                        .concatWith(coreLogic)
                        .concatWith(Flowable.just(runFinishedEvent(runContext.sessionId(), runContext.runId())))
                        .onErrorResumeNext((Throwable error) -> Flowable.just(runErrorEvent(error.getMessage())));

            } catch (Exception e) {
                logger.error("Failed to prepare reactive agent run", e);
                return Flowable.just(runErrorEvent(e.getMessage()));
            }
        });
    }


    private Flowable<BaseEvent> processUnseenMessages(RunContext runContext, RunAgentParameters parameters, Set<String> processedIds, Session session) {
        List<BaseMessage> unseenMessages = parameters.getMessages().stream()
            .filter(message -> message.getId() != null && !processedIds.contains(message.getId()))
            .toList();

        List<MessageChunk> chunks = messageProcessor.groupMessagesIntoChunks(unseenMessages);

        if (chunks.isEmpty()) {
            return Flowable.empty();
        }

        boolean hasToolSubmission = chunks.stream().anyMatch(MessageChunk::isToolSubmission);

        Map<String, String> toolCallIdToName = hasToolSubmission
            ? buildToolCallIdToName(parameters.getMessages())
            : Map.of();

        return processAllChunks(runContext, chunks, session, toolCallIdToName);
    }

    private Flowable<BaseEvent> processAllChunks(RunContext runContext, List<MessageChunk> chunks, Session session, Map<String, String> toolCallIdToName) {
        return Flowable.fromIterable(chunks)
                       .concatMap(chunk -> processChunk(runContext, chunk, session, toolCallIdToName));
    }

    private Flowable<BaseEvent> processChunk(RunContext runContext, MessageChunk chunk, Session session, Map<String, String> toolCallIdToName) {
        markMessagesAsProcessed(chunk.toolMessages(), session);
        markMessagesAsProcessed(chunk.userSystemMessages(), session);

        return chunk.isToolSubmission()
                ? handleToolResultSubmission(runContext, chunk, session, toolCallIdToName)
                : startNewExecution(runContext, chunk.userSystemMessages(), List.of());
    }

    private Flowable<BaseEvent> handleToolResultSubmission(RunContext runContext, MessageChunk chunk, Session session, Map<String, String> toolCallIdToName) {
        return sessionManager.processToolResults(session, chunk.toolMessages(), toolCallIdToName)
                .toList()
                .filter(validResults -> !validResults.isEmpty()) // Returns a Maybe
                .flatMapPublisher(validResults -> // This is only called if the list is not empty
                        startNewExecution(runContext, chunk.userSystemMessages(), validResults)
                );
    }

    private Flowable<BaseEvent> startNewExecution(RunContext runContext, List<BaseMessage> messageBatch, List<ToolResult> toolResults) {
        EventTranslator translator = eventTranslatorFactory.create(runContext.sessionId(), runContext.runId());

        // Construct Content for ADK runner
        return this.messageProcessor.constructMessageToSend(messageBatch, toolResults)
                .map(messageToSend -> runner.runAsync(runContext.userId(), runContext.sessionId(), messageToSend, runConfig)
                        .compose(translator)
                        .doOnError(error -> logger.error("Error during ADK run for appName '{}', sessionId '{}'",
                                runContext.appName(), runContext.sessionId(), error)))
                .orElse(Flowable.empty()); // If no content, return an empty flowable
    }

    private Map<String, String> buildToolCallIdToName(List<BaseMessage> messages) {
        return messages.stream()
                .filter(AssistantMessage.class::isInstance)
                .map(AssistantMessage.class::cast)
                .map(AssistantMessage::getToolCalls)
                .filter(Objects::nonNull)
                .flatMap(List::stream)
                .collect(Collectors.toMap(
                    ToolCall::id,
                    tc -> tc.function().name(),
                    (existingValue, newValue) -> newValue
                ));
    }

    private void markMessagesAsProcessed(List<BaseMessage> messages, Session session) {
        Optional.ofNullable(messages)
            .filter(list -> !list.isEmpty())
            .map(list -> list.stream()
                    .map(BaseMessage::getId)
                    .filter(Objects::nonNull)
                    .toList())
            .filter(list -> !list.isEmpty())
            .ifPresent(messageIds -> sessionManager.markMessagesProcessed(session, messageIds).subscribe());
    }
}