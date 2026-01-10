package com.agui.adk;

import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.ListSessionsResponse;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

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
    @Mock
    private RunContext runContext;
    @Mock
    private Session session;

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        sessionManager = new SessionManager(sessionService, memoryService);

        // Common mocks for RunContext
        when(runContext.appName()).thenReturn("test-app");
        when(runContext.userId()).thenReturn("test-user");
        when(runContext.sessionId()).thenReturn("test-session");

        // Common mocks for Session
        when(session.id()).thenReturn("test-session");
        when(session.appName()).thenReturn("test-app");
        when(session.userId()).thenReturn("test-user");
        when(session.state()).thenReturn(new ConcurrentHashMap<>());
    }

    @Test
    void shouldCreateNewSession_whenNoneExists() {
        // Arrange
        when(sessionService.getSession(any(), any(), any(), any())).thenReturn(Maybe.empty());
        when(sessionService.createSession(any(), any(), any(), any())).thenReturn(Single.just(session));

        // Act
        Session resultSession = sessionManager.getOrCreateSession(runContext).blockingGet();

        // Assert
        assertNotNull(resultSession);
        assertEquals(session, resultSession);
        verify(sessionService, times(1)).getSession("test-app", "test-user", "test-session", Optional.empty());
        verify(sessionService, times(1)).createSession("test-app", "test-user", null, "test-session");
    }

    @Test
    void shouldReturnExistingSession_whenOneExists() {
        // Arrange
        when(sessionService.getSession(any(), any(), any(), any())).thenReturn(Maybe.just(session));

        // Act
        Session resultSession = sessionManager.getOrCreateSession(runContext).blockingGet();

        // Assert
        assertNotNull(resultSession);
        assertEquals(session, resultSession);
        verify(sessionService, times(1)).getSession("test-app", "test-user", "test-session", Optional.empty());
        verify(sessionService, never()).createSession(any(), any(), any(), any());
    }

    @Test
    void shouldDeleteAllUserSessions_whenRequested() {
        // Arrange
        Session session1 = mock(Session.class);
        Session session2 = mock(Session.class);
        ListSessionsResponse response = mock(ListSessionsResponse.class);

        when(response.sessions()).thenReturn(List.of(session1, session2));
        when(sessionService.listSessions(any(), any())).thenReturn(Single.just(response));
        
        when(memoryService.addSessionToMemory(any(Session.class))).thenReturn(Completable.complete());
        when(sessionService.deleteSession(any(), any(), any())).thenReturn(Completable.complete());

        // Act
        sessionManager.deleteAllUserAppNameSessions("test-app", "test-user").blockingAwait();

        // Assert
        verify(sessionService, times(1)).listSessions("test-app", "test-user");
        verify(sessionService, times(2)).deleteSession(any(), any(), any());
        verify(memoryService, times(2)).addSessionToMemory(any());
    }
    
    @Test
    void shouldAppendMessageIdsToState_whenMarkingAsProcessed() {
        // Arrange
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(mock(com.google.adk.events.Event.class)));
        List<String> messageIds = List.of("msg-1", "msg-2");

        // Act
        sessionManager.markMessagesProcessed(session, messageIds).blockingAwait();

        // Assert
        verify(sessionService, times(1)).appendEvent(eq(session), argThat(event -> {
            Map<String, Object> stateDelta = event.actions().stateDelta();
            return stateDelta != null && stateDelta.containsKey("processedMessageIds");
        }));
    }
}
