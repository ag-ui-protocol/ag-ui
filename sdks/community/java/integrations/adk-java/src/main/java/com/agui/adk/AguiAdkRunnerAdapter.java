package com.agui.adk;

import com.agui.core.agent.AgentSubscriber;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.message.BaseMessage;
import com.agui.core.message.Role;
import com.agui.server.ServerAgent;
import com.google.adk.agents.RunConfig;
import com.google.adk.runner.Runner;
import com.google.genai.types.Content;
import com.google.genai.types.Part;
import io.reactivex.rxjava3.disposables.Disposable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;

import static com.agui.server.EventFactory.*;

public class AguiAdkRunnerAdapter extends ServerAgent {

    private static final Logger logger = LoggerFactory.getLogger(AguiAdkRunnerAdapter.class);

    private final Runner runner;
    private final SessionManager sessionManager;
    private final RunConfig runConfig;
    private final Function<RunAgentParameters, String> userIdExtractor;
    private final EventTranslatorFactory eventTranslatorFactory;

    public AguiAdkRunnerAdapter(
            Runner runner,
            SessionManager sessionManager,
            RunConfig runConfig,
            Function<RunAgentParameters, String> userIdExtractor
    ) {
        this(runner, sessionManager, runConfig, userIdExtractor, new DefaultEventTranslatorFactory());
    }

    AguiAdkRunnerAdapter(
            Runner runner,
            SessionManager sessionManager,
            RunConfig runConfig,
            Function<RunAgentParameters, String> userIdExtractor,
            EventTranslatorFactory eventTranslatorFactory
    ) {
        super();
        this.runner = runner;
        this.sessionManager = sessionManager;
        this.runConfig = runConfig;
        this.userIdExtractor = userIdExtractor;
        this.eventTranslatorFactory = eventTranslatorFactory;
    }

    @Override
    public CompletableFuture<Void> runAgent(RunAgentParameters parameters, AgentSubscriber subscriber) {
        CompletableFuture<Void> future = new CompletableFuture<>();
        try {
            // 1. Synchronous setup
            String appName = this.runner.appName();
            String userId = userIdExtractor.apply(parameters);

            // 2. Delegate to the asynchronous workflow
            initiateSessionAndRun(appName, userId, parameters, subscriber, future);

        } catch (Exception e) {
            // Catches synchronous errors from parameter extraction.
            logger.error("Failed to prepare agent run", e);
            this.emitEvent(runErrorEvent(e.getMessage()), subscriber);
            future.completeExceptionally(e);
        }
        return future;
    }

    /**
     * Initiates the session creation and chains the rest of the agent execution.
     */
    private void initiateSessionAndRun(String appName, String userId, RunAgentParameters parameters, AgentSubscriber subscriber, CompletableFuture<Void> future) {
        String sessionId = parameters.getThreadId();
        sessionManager.getOrCreateSession(sessionId, appName, userId)
            .thenAccept(session -> executeAdkFlow(appName, userId, parameters, subscriber, future))
            .exceptionally(ex -> {
                logger.error("Failed to get or create session for appName '{}'", appName, ex);
                this.emitEvent(runErrorEvent(ex.getMessage()), subscriber);
                future.completeExceptionally(ex);
                return null;
            });
    }

    /**
     * Executes the core ADK agent flow once a session is available.
     */
    private void executeAdkFlow(String appName, String userId, RunAgentParameters parameters, AgentSubscriber subscriber, CompletableFuture<Void> future) {
        try {
            String sessionId = parameters.getThreadId();
            String runId = parameters.getRunId() != null ? parameters.getRunId() : UUID.randomUUID().toString();

            EventTranslator eventTranslator = eventTranslatorFactory.create();
            Content latestMessage = createContentFromLatestMessage(parameters.getMessages());

            this.emitEvent(runStartedEvent(sessionId, runId), subscriber);

            final Disposable disposable = runner.runAsync(userId, sessionId, latestMessage, runConfig)
                .concatMap(eventTranslator::translate)
                .concatWith(eventTranslator.forceCloseStreamingMessage())
                .subscribe(
                    event -> this.emitEvent(event, subscriber),
                    error -> handleStreamError(error, appName, subscriber, future),
                    () -> handleStreamCompletion(sessionId, runId, subscriber, future)
                );

            // Link the CompletableFuture's cancellation to the disposable
            future.whenComplete((res, err) -> {
                if (future.isCancelled()) {
                    disposable.dispose();
                }
            });
        } catch (Exception e) {
            // Catches synchronous errors from within the thenAccept block (e.g., runner.getRunner)
            logger.error("Failed to start agent run for appName '{}'", appName, e);
            this.emitEvent(runErrorEvent(e.getMessage()), subscriber);
            future.completeExceptionally(e);
        }
    }

    /**
     * Handles errors that occur within the reactive stream.
     */
    private void handleStreamError(Throwable error, String appName, AgentSubscriber subscriber, CompletableFuture<Void> future) {
        logger.error("Error during ADK run for appName '{}'", appName, error);
        this.emitEvent(runErrorEvent(error.getMessage()), subscriber);
        future.completeExceptionally(error);
    }

    /**
     * Handles the successful completion of the reactive stream.
     */
    private void handleStreamCompletion(String sessionId, String runId, AgentSubscriber subscriber, CompletableFuture<Void> future) {
        this.emitEvent(runFinishedEvent(sessionId, runId), subscriber);
        future.complete(null);
    }

    private Content createContentFromLatestMessage(List<BaseMessage> messages) {
        if (messages == null || messages.isEmpty()) {
            return null;
        }
        return messages.stream()
                .filter(m -> m.getRole() == Role.user)
                .reduce((first, second) -> second) // Get the last user message
                .map(latestUserMessage -> Content.builder()
                        .role("user")
                        .parts(List.of(Part.builder().text(latestUserMessage.getContent()).build()))
                        .build())
                .orElse(null);
    }

    @Override
    public List<BaseMessage> getMessages() {
        return List.of();
    }
}