package com.agui.adk.translator;

import com.agui.adk.translator.step.EventTranslationStep;
import com.agui.core.event.BaseEvent;
import com.google.adk.events.Event;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.subscribers.TestSubscriber;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class EventTranslatorTest {

    private EventTranslator eventTranslator;

    @Mock
    private TranslationContext context;
    @Mock
    private EventTranslationStep step1;
    @Mock
    private EventTranslationStep step2;

    @BeforeEach
    void setUp() {
        eventTranslator = new EventTranslator(context, List.of(step1, step2));
    }

    @Test
    void shouldTranslateStreamAndAppendDeferredEvents_whenApplied() {
        // Arrange
        Event inputEvent = mock(Event.class);
        BaseEvent translatedEvent = mock(BaseEvent.class);
        BaseEvent deferredEvent = mock(BaseEvent.class);

        when(step1.translate(any(Event.class), any(TranslationContext.class))).thenReturn(Flowable.just(translatedEvent));
        when(step2.translate(any(Event.class), any(TranslationContext.class))).thenReturn(Flowable.empty());
        when(context.getAndClearDeferredConfirmEvents()).thenReturn(List.of(deferredEvent));

        Flowable<Event> upstream = Flowable.just(inputEvent);

        // Act
        TestSubscriber<BaseEvent> testSubscriber = Flowable.fromPublisher(eventTranslator.apply(upstream)).test();

        // Assert
        testSubscriber.assertValueCount(2); // Translated + Deferred
        testSubscriber.assertComplete();
        testSubscriber.assertValues(translatedEvent, deferredEvent);
    }
    @Test
    void shouldDelegateToAllSteps_whenTranslateIsCalled() {
        Event inputEvent = mock(Event.class);
        when(step1.translate(any(Event.class), any(TranslationContext.class))).thenReturn(Flowable.empty());
        when(step2.translate(any(Event.class), any(TranslationContext.class))).thenReturn(Flowable.empty());

        eventTranslator.translate(inputEvent).test().assertComplete();

        verify(step1, times(1)).translate(inputEvent, context);
        verify(step2, times(1)).translate(inputEvent, context);
    }
    @Test
    void shouldDelegateToContext_whenDeferredEventsAreCleared() {
        when(context.getAndClearDeferredConfirmEvents()).thenReturn(List.of(mock(BaseEvent.class)));

        List<BaseEvent> result = eventTranslator.getAndClearDeferredConfirmEvents();

        verify(context, times(1)).getAndClearDeferredConfirmEvents();
        assertEquals(1, result.size());
    }
}
