package com.agui.adk;

import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.Session;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.concurrent.ExecutionException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class SessionManagerTest {

    private SessionManager sessionManager;

    @Mock
    private BaseSessionService sessionService;

    @Mock
    private BaseMemoryService memoryService;

    private AutoCloseable mocks;

    @BeforeEach
    void setUp() {
        mocks = MockitoAnnotations.openMocks(this);
        sessionManager = new SessionManager(
                sessionService,
                memoryService,
                Duration.ofMinutes(20),
                Duration.ofMinutes(5)
        );

        when(memoryService.addSessionToMemory(any(Session.class)))
                .thenReturn(Completable.complete());
    }

    @AfterEach
    void tearDown() throws Exception {
        sessionManager.shutdown();
        mocks.close();
    }

    @Test
    void getOrCreateSession_shouldCreateNewSession_whenNoneExists() throws ExecutionException, InterruptedException {
        // --- Setup ---
        String sessionId = "new-session";
        String appName = "test-app";
        String userId = "test-user";

        Session newSession = mock(Session.class);
        when(newSession.id()).thenReturn(sessionId);
        when(newSession.appName()).thenReturn(appName);

        when(sessionService.getSession(any(), any(), any(), any())).thenReturn(Maybe.empty());
        when(sessionService.createSession(any(), any(), any(), any())).thenReturn(Single.just(newSession));

        // --- Execution ---
        Session session = sessionManager.getOrCreateSession(sessionId, appName, userId).get();

        // --- Verification ---
        assertNotNull(session);
        assertEquals(newSession, session);
        verify(sessionService, times(1)).getSession(appName, userId, sessionId, Optional.empty());
        verify(sessionService, times(1)).createSession(appName, userId, null, sessionId);
    }

    @Test
    void getOrCreateSession_shouldReturnExistingSession() throws ExecutionException, InterruptedException {
        // --- Setup ---
        String sessionId = "existing-session";
        String appName = "test-app";
        String userId = "test-user";

        Session existingSession = mock(Session.class);
        when(sessionService.getSession(any(), any(), any(), any())).thenReturn(Maybe.just(existingSession));

        // --- Execution ---
        Session session = sessionManager.getOrCreateSession(sessionId, appName, userId).get();

        // --- Verification ---
        assertNotNull(session);
        assertEquals(existingSession, session);
        verify(sessionService, times(1)).getSession(appName, userId, sessionId, Optional.empty());
        verify(sessionService, never()).createSession(any(), any(), any(), any());
    }

    @Test
    void cleanupExpiredSessions_shouldRemoveExpiredSession() throws InterruptedException {
        // --- Setup ---
        // Re-initialize SessionManager with a very short timeout for this test
        sessionManager.shutdown(); // Shutdown the one from setUp
        sessionManager = new SessionManager(
                sessionService,
                memoryService,
                Duration.ofMillis(100), // Expire after 100ms
                Duration.ofMillis(200)  // Cleanup runs every 200ms
        );

        String sessionId = "expired-session";
        String appName = "test-app";
        String userId = "test-user";

        Session expiredSession = mock(Session.class);
        when(expiredSession.id()).thenReturn(sessionId);
        when(expiredSession.appName()).thenReturn(appName);
        when(expiredSession.userId()).thenReturn(userId);
        // Make the session appear old
        when(expiredSession.lastUpdateTime()).thenReturn(Instant.now().minusSeconds(10));

        // Stub the service calls
        when(sessionService.getSession(appName, userId, sessionId, Optional.empty())).thenReturn(Maybe.just(expiredSession));
        when(sessionService.createSession(any(), any(), any(), any())).thenReturn(Single.just(expiredSession));
        when(sessionService.deleteSession(any(), any(), any())).thenReturn(Completable.complete());

        // --- Execution ---
        // 1. Create a session to get it into the manager's internal map
        sessionManager.getOrCreateSession(sessionId, appName, userId);

        // 2. Wait for the cleanup task to run
        Thread.sleep(300);

        // --- Verification ---
        // 3. Verify that the delete method was called on the underlying service
        verify(sessionService, times(1)).deleteSession(sessionId, appName, userId);
    }
}
