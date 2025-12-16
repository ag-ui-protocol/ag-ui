package com.agui.adk;

import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.Session;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.disposables.CompositeDisposable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.*;

import static java.util.concurrent.TimeUnit.MILLISECONDS;

public class SessionManager {

    private static final Logger logger = LoggerFactory.getLogger(SessionManager.class);
    private final BaseSessionService sessionService;
    private final BaseMemoryService memoryService;
    private final Duration sessionTimeout;
    private final ScheduledExecutorService cleanupScheduler;
    private final Map<String, String> sessionUserMap = new ConcurrentHashMap<>(); // sessionKey -> userId
    private final Map<String, Set<String>> userSessionsMap = new ConcurrentHashMap<>(); // userId -> set of sessionKeys
    private final CompositeDisposable cleanupDisposables = new CompositeDisposable();

    /**
     * Public constructor for Spring-friendly bean creation.
     * @param sessionService The ADK session service.
     * @param memoryService The ADK memory service (optional).
     * @param sessionTimeout The duration after which inactive sessions expire.
     * @param cleanupInterval The interval at which to run the cleanup task.
     */
    public SessionManager(BaseSessionService sessionService, BaseMemoryService memoryService, Duration sessionTimeout, Duration cleanupInterval) {
        this.sessionService = sessionService;
        this.memoryService = memoryService;
        this.sessionTimeout = sessionTimeout;
        this.cleanupScheduler = Executors.newSingleThreadScheduledExecutor();
        this.startCleanupTask(cleanupInterval);
        logger.info("SessionManager initialized with timeout: {} and cleanup interval: {}", sessionTimeout, cleanupInterval);
    }

    public CompletableFuture<Session> getOrCreateSession(String sessionId, String appName, String userId) {
        CompletableFuture<Session> future = new CompletableFuture<>();

        var disposable = sessionService.getSession(appName, userId, sessionId, Optional.empty())
                .doOnSuccess(session -> logger.debug("Reusing existing session: {} for user: {}", makeSessionKey(appName, sessionId), userId))
                .switchIfEmpty(Single.defer(() -> {
                    logger.info("Creating new session: {} for user: {}", makeSessionKey(appName, sessionId), userId);
                    // Assuming sessionService.createSession returns a Single<Session>
                    return sessionService.createSession(appName, userId,  null, sessionId);
                }))
                .doOnSuccess(session -> trackSession(session, userId))
                .subscribe(
                        future::complete, // OnSuccess
                        future::completeExceptionally // OnError
                );

        future.whenComplete((session, throwable) -> {
            if (future.isCancelled()) {
                disposable.dispose();
            }
        });

        return future;
    }

    private void trackSession(Session session, String userId) {
        String sessionKey = makeSessionKey(session.appName(), session.id());
        sessionUserMap.put(sessionKey, userId);
        userSessionsMap.computeIfAbsent(userId, k -> ConcurrentHashMap.newKeySet()).add(sessionKey);
    }

    private void untrackSession(String sessionKey) {
        String userId = sessionUserMap.remove(sessionKey);
        if (userId != null && userSessionsMap.containsKey(userId)) {
            userSessionsMap.get(userId).remove(sessionKey);
            if (userSessionsMap.get(userId).isEmpty()) {
                userSessionsMap.remove(userId);
            }
        }
    }

private void deleteSession(Session session) {
    if (memoryService != null) {
        var memoryDisposable = memoryService.addSessionToMemory(session)
            .subscribe(
                () -> logger.debug("Session {} saved to memory.", session.id()),
                ex -> logger.error("Failed to save session {} to memory.", session.id(), ex)
            );
        cleanupDisposables.add(memoryDisposable);
    }

    var deleteDisposable = sessionService.deleteSession(session.id(), session.appName(), session.userId())
        .subscribe(
            () -> {
                untrackSession(makeSessionKey(session.appName(), session.id()));
                logger.info("Session {} deleted.", session.id());
            },
            ex -> logger.error("Failed to delete session {}.", session.id(), ex)
        );
    cleanupDisposables.add(deleteDisposable);
}

    private String makeSessionKey(String appName, String sessionId) {
        return appName + ":" + sessionId;
    }

    private void startCleanupTask(Duration cleanupInterval) {
        cleanupScheduler.scheduleAtFixedRate(this::cleanupExpiredSessions, cleanupInterval.toMillis(), cleanupInterval.toMillis(), MILLISECONDS);
    }

    private void cleanupExpiredSessions() {
        long now = System.currentTimeMillis();
        sessionUserMap.keySet().forEach(sessionKey -> {
            String[] parts = sessionKey.split(":", 2);
            String appName = parts[0];
            String sessionId = parts[1];
            String userId = sessionUserMap.get(sessionKey);

            if (userId == null) return;

            var disposable = sessionService.getSession(appName, userId, sessionId, Optional.empty())
                    .filter(session -> (now - session.lastUpdateTime().toEpochMilli()) > sessionTimeout.toMillis())
                    .subscribe(
                            session -> {
                                logger.info("Session {} has expired. Cleaning up.", sessionKey);
                                deleteSession(session);
                            },
                            ex -> logger.error("Error during session cleanup for session key: {}", sessionKey, ex)
                    );
            cleanupDisposables.add(disposable);
        });
    }

    public void shutdown() {
        cleanupScheduler.shutdown();
        cleanupDisposables.dispose();
    }
}
