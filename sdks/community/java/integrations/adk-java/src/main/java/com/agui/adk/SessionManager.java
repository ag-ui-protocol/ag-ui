package com.agui.adk;

import com.agui.adk.processor.ToolResult;
import com.agui.core.message.BaseMessage;
import com.agui.core.message.ToolMessage;
import com.google.adk.events.Event;
import com.google.adk.events.EventActions;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.ListSessionsResponse;
import com.google.adk.sessions.Session;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import org.jetbrains.annotations.NotNull;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.function.BiFunction;
import java.util.function.BinaryOperator;
import java.util.stream.Collectors;

public final class SessionManager {

    private static final Logger logger = LoggerFactory.getLogger(SessionManager.class);
    private static final String PROCESSED_MESSAGE_IDS_KEY = "processedMessageIds";
    private static final String PENDING_TOOL_CALL_IDS_KEY = "pendingToolCallIds";
    private final BaseSessionService sessionService;
    private final BaseMemoryService memoryService;

    record SessionWithProcessedIds(Session session, Set<String> processedIds) {}
    private record ToolProcessingAccumulator(List<ToolResult> validResults, Set<String> processedIds) {}


    public SessionManager(BaseSessionService sessionService, BaseMemoryService memoryService) {
        this.sessionService = sessionService;
        this.memoryService = memoryService;
    }

    public Completable deleteAllUserAppNameSessions(String appName, String userId) {
        return sessionService.listSessions(appName, userId)
                .toFlowable()
                .map(ListSessionsResponse::sessions)
                .flatMapIterable(userSessions -> userSessions)
                .flatMapCompletable(this::deleteSession)
                .doOnComplete(() -> logger.info("Cleanup for user {} in app {} completed successfully.", userId, appName))
                .doOnError(ex -> logger.error("Failed to cleanup sessions for user {} in app {}.", userId, appName, ex));
    }

    Single<SessionWithProcessedIds> getSessionAndProcessedMessageIds(RunContext context) {
        return getOrCreateSession(context)
            .flatMap(session -> getProcessedMessageIds(session)
                    .map(processedIds -> new SessionWithProcessedIds(session, processedIds))
            );
    }

    Flowable<ToolResult> processToolResults(Session session, List<BaseMessage> toolMessages, Map<String, String> toolCallIdToName) {
        return getPendingToolCallIds(session)
                .collect(Collectors.toSet())
                .flatMapPublisher(pendingIds -> finalizeToolResults(session, toolMessages, toolCallIdToName, pendingIds));
    }

    Completable markMessagesProcessed(Session session, List<String> messageIds) {
        return Optional.ofNullable(messageIds)
                .filter(ids -> !ids.isEmpty())
                .map(ids -> processAndAppendEvent(session, ids))
                .orElse(Completable.complete());
    }

    private Completable processAndAppendEvent(Session session, List<String> ids) {
        Set<String> updatedProcessedIds = getUpdatedProcessedIds(session);
        updatedProcessedIds.addAll(ids);
        ConcurrentMap<String, Object> stateDelta = new ConcurrentHashMap<>();
        stateDelta.put(PROCESSED_MESSAGE_IDS_KEY, updatedProcessedIds);
        EventActions actions = EventActions.builder().stateDelta(stateDelta).build();

        Event event = Event.builder()
                .invocationId("processed_messages_" + Instant.now().toEpochMilli())
                .author("system")
                .actions(actions)
                .timestamp(Instant.now().toEpochMilli())
                .build();

        return sessionService.appendEvent(session, event).ignoreElement();
    }

    @NotNull
    private static Set<String> getUpdatedProcessedIds(Session session) {
        ConcurrentMap<String, Object> sessionState = session.state();
        Object storedValue = sessionState.get(PROCESSED_MESSAGE_IDS_KEY);

        Set<String> updatedProcessedIds = new HashSet<>();
        if (storedValue instanceof Set) {
            updatedProcessedIds = ((Set<?>) storedValue).stream()
                    .filter(String.class::isInstance)
                    .map(String.class::cast)
                    .collect(Collectors.toSet());
        }
        return updatedProcessedIds;
    }

    private Single<Session> getOrCreateSession(RunContext context) {
        String sessionId = context.sessionId();
        String appName = context.appName();
        String userId = context.userId();

        return sessionService.getSession(appName, userId, sessionId, Optional.empty())
                .doOnSuccess(session -> logger.debug("Reusing existing session: {} for appname  : {} and user: {}", sessionId, appName, userId))
                .switchIfEmpty(Single.defer(() -> {
                    logger.info("Creating new session: {} for appname  : {} and user: {}", sessionId, appName, userId);
                    return sessionService.createSession(appName, userId, null, sessionId);
                }));
    }
    private Single<Set<String>> getProcessedMessageIds(Session session) {
        Object storedValue = session.state().get(PROCESSED_MESSAGE_IDS_KEY);
        Set<String> processedIds = Set.of();
        if (storedValue instanceof Set) {
            processedIds = ((Set<?>) storedValue).stream()
                    .filter(String.class::isInstance)
                    .map(String.class::cast)
                    .collect(Collectors.toUnmodifiableSet());
        }
        return Single.just(processedIds);
    }

    @NotNull
    private Flowable<ToolResult> finalizeToolResults(Session session, List<BaseMessage> toolMessages, Map<String, String> toolCallIdToName, Set<String> pendingIds) {
        ToolProcessingAccumulator toolProcessingAccumulator = accumulateValidToolResults(toolMessages, toolCallIdToName, pendingIds);

        if (toolProcessingAccumulator.validResults.isEmpty()) {
            return Flowable.empty();
        }

        Set<String> newPendingIds = new HashSet<>(pendingIds);
        newPendingIds.removeAll(toolProcessingAccumulator.processedIds);

        return updatePendingToolCallIds(session, newPendingIds)
                .andThen(Flowable.fromIterable(toolProcessingAccumulator.validResults));
    }

    private static ToolProcessingAccumulator accumulateValidToolResults(List<BaseMessage> toolMessages, Map<String, String> toolCallIdToName, Set<String> pendingIds) {
        return toolMessages.stream()
            .filter(baseMessage -> baseMessage instanceof ToolMessage)
            .map(baseMessage -> (ToolMessage) baseMessage)
            .reduce(
                new ToolProcessingAccumulator(new ArrayList<>(), new HashSet<>()), // Supplier
                    createToolProcessingAccumulatorFunction(toolCallIdToName, pendingIds),
                    createToolProcessingCombiner()
            );
    }

    @NotNull
    private static BinaryOperator<ToolProcessingAccumulator> createToolProcessingCombiner() {
        return (acc1, acc2) -> {
            acc1.validResults.addAll(acc2.validResults);
            acc1.processedIds.addAll(acc2.processedIds);
            return acc1;
        };
    }

    @NotNull
    private static BiFunction<ToolProcessingAccumulator, ToolMessage, ToolProcessingAccumulator> createToolProcessingAccumulatorFunction(Map<String, String> toolCallIdToName, Set<String> pendingIds) {
        return (acc, toolMessage) -> { // Accumulator
            String toolCallId = toolMessage.getToolCallId();
            String toolName = toolCallIdToName.get(toolCallId);

            if (pendingIds.contains(toolCallId) && !"confirm_changes".equals(toolName)) {
                acc.validResults().add(new ToolResult(toolName, toolMessage));
                acc.processedIds().add(toolCallId);
            }
            return acc;
        };
    }

    private Flowable<String> getPendingToolCallIds(Session session) {
        Object storedValue = session.state().get(PENDING_TOOL_CALL_IDS_KEY);
        if (storedValue instanceof Set) {
            return Flowable.fromIterable((Set<?>) storedValue)
                .filter(String.class::isInstance)
                .map(String.class::cast);
        }
        return Flowable.empty();
    }

    private Completable updatePendingToolCallIds(Session session, Set<String> updatedPendingIds) {
        ConcurrentMap<String, Object> stateDelta = new ConcurrentHashMap<>();
        stateDelta.put(PENDING_TOOL_CALL_IDS_KEY, updatedPendingIds);

        EventActions actions = EventActions.builder().stateDelta(stateDelta).build();

        Event event = Event.builder()
                .invocationId("updated_pending_tool_calls_" + Instant.now().toEpochMilli())
                .author("system")
                .actions(actions)
                .timestamp(Instant.now().toEpochMilli())
                .build();

        return sessionService.appendEvent(session, event).ignoreElement();
    }

    private Completable deleteSession(Session session) {
        return memoryService.addSessionToMemory(session)
                .doOnError(ex -> logger.error("Failed to save session {} to memory.", session.id(), ex))
                .andThen(
                        sessionService.deleteSession(session.id(), session.appName(), session.userId())
                                .doOnComplete(() -> logger.info("Session {} deleted.", session.id()))
                                .doOnError(ex -> logger.error("Failed to delete session {}.", session.id(), ex))
                );
    }
}