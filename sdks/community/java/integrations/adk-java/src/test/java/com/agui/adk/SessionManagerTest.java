package com.agui.adk;

import com.google.adk.events.Event;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.ListSessionsResponse;
import com.google.adk.sessions.Session;
import com.google.common.collect.ImmutableList;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.observers.TestObserver;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
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
        sessionManager = new SessionManager(sessionService, memoryService);
    }

    @Test
    void shouldGetSessionAndProcessedIds_whenSessionExists() {
        // Arrange
//        setupDefaultMocks();
        when(sessionService.getSession(any(), any(), any(), any())).thenReturn(Maybe.just(session));
        when(session.state()).thenReturn(new ConcurrentHashMap<>());

        // Act
        TestObserver<SessionManager.SessionWithProcessedIds> testObserver = new TestObserver<>();
        sessionManager.getSessionAndProcessedMessageIds(runContext).subscribe(testObserver);

        // Assert
        testObserver.assertComplete();
        testObserver.assertNoErrors();
        testObserver.assertValueCount(1);
        testObserver.assertValue(data -> data.session().equals(session) && data.processedIds().isEmpty());

        verify(sessionService, times(1)).getSession(any(), any(), any(), any());
        verify(sessionService, never()).createSession(any(), any(), any(), any());
    }

    @Test
    void shouldDeleteAllUserSessions_whenRequested() {
        // Arrange
        Session session1 = mock(Session.class);
        Session session2 = mock(Session.class);
        ListSessionsResponse response = mock(ListSessionsResponse.class);

        when(response.sessions()).thenReturn(ImmutableList.of(session1, session2));
        when(sessionService.listSessions(any(), any())).thenReturn(Single.just(response));

        when(memoryService.addSessionToMemory(any(Session.class))).thenReturn(Completable.complete());
        when(sessionService.deleteSession(any(), any(), any())).thenReturn(Completable.complete());

        // Act
        TestObserver<Void> testObserver = new TestObserver<>();
        sessionManager.deleteAllUserAppNameSessions("test-app", "test-user").subscribe(testObserver);

        // Assert
        testObserver.assertComplete();
        testObserver.assertNoErrors();

        verify(sessionService, times(1)).listSessions("test-app", "test-user");
        verify(sessionService, times(2)).deleteSession(any(), any(), any());
        verify(memoryService, times(2)).addSessionToMemory(any());
    }

    @Test
    void shouldAppendMessageIdsToState_whenMarkingAsProcessed() {
        // Arrange
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(mock(Event.class)));
        when(session.state()).thenReturn(new ConcurrentHashMap<>());
        List<String> messageIds = List.of("msg-1", "msg-2");

        // Act
        TestObserver<Void> testObserver = new TestObserver<>();
        sessionManager.markMessagesProcessed(session, messageIds).subscribe(testObserver);

        // Assert
        testObserver.assertComplete();
        testObserver.assertNoErrors();

        verify(sessionService, times(1)).appendEvent(eq(session), argThat(event -> {
            Map<String, Object> stateDelta = event.actions().stateDelta();
            return stateDelta != null && stateDelta.containsKey("processedMessageIds");
        }));
    }
}
