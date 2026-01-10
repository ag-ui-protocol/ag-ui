package com.agui.adk.translator.step;

import com.agui.adk.translator.TranslationContext;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.StateDeltaEvent;
import com.google.adk.events.Event;
import com.google.adk.events.EventActions;
import io.reactivex.rxjava3.subscribers.TestSubscriber;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.when;

class StateDeltaTranslationStepTest {

    private StateDeltaTranslationStep translationStep;

    @Mock
    private Event event;

    @Mock
    private EventActions actions;

    @Mock
    private TranslationContext context;

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        translationStep = StateDeltaTranslationStep.INSTANCE;
        when(event.actions()).thenReturn(actions);
    }

    @Test
    void shouldReturnEmpty_whenStateDeltaIsNull() {
        // Arrange
        when(actions.stateDelta()).thenReturn(null);

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }

    @Test
    void shouldReturnEmpty_whenStateDeltaIsEmpty() {
        // Arrange
        when(actions.stateDelta()).thenReturn(new ConcurrentHashMap<>());

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }

    @Test
    void shouldReturnStateDeltaEvent_whenStateDeltaIsPresent() {
        // Arrange
        ConcurrentMap<String, Object> stateDelta = new ConcurrentHashMap<>();
        stateDelta.put("key1", "value1");
        stateDelta.put("key2", 123);
        when(actions.stateDelta()).thenReturn(stateDelta);

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertValueCount(1);
        testSubscriber.assertComplete();

        BaseEvent emittedEvent = testSubscriber.values().get(0);
        assertTrue(emittedEvent instanceof StateDeltaEvent);
        StateDeltaEvent stateDeltaEvent = (StateDeltaEvent) emittedEvent;
        
        List<Map<String, Object>> patches = (List<Map<String, Object>>) stateDeltaEvent.getRawEvent();
        assertEquals(2, patches.size());

        // Check patch for key1
        Map<String, Object> patch1 = patches.stream().filter(p -> p.get("path").equals("/key1")).findFirst().get();
        assertEquals("add", patch1.get("op"));
        assertEquals("value1", patch1.get("value"));

        // Check patch for key2
        Map<String, Object> patch2 = patches.stream().filter(p -> p.get("path").equals("/key2")).findFirst().get();
        assertEquals("add", patch2.get("op"));
        assertEquals(123, patch2.get("value"));
    }
}
