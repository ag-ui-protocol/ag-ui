package com.agui.adk.translator.step;

import com.agui.adk.translator.TranslationContext;
import com.agui.adk.translator.context.StreamingState;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.TextMessageContentEvent;
import com.agui.core.event.TextMessageEndEvent;
import com.agui.core.event.TextMessageStartEvent;
import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.Part;
import io.reactivex.rxjava3.subscribers.TestSubscriber;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.util.List;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class TextMessageStreamStepTest {

    private TextMessageStreamStep translationStep;

    @Mock
    private Event event;
    @Mock
    private TranslationContext context;
    @Mock
    private StreamingState streamingState;
    @Mock
    private Content content;
    @Mock
    private Part part;

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        translationStep = TextMessageStreamStep.INSTANCE;
        
        // Default mock behaviors
        when(event.content()).thenReturn(Optional.of(content));
        when(content.parts()).thenReturn(Optional.of(List.of(part)));
        when(part.text()).thenReturn(Optional.of(""));
    }

    private void mockEventText(String text) {
        when(part.text()).thenReturn(Optional.of(text));
    }

    @Test
    void shouldEmitStartContentEnd_whenNonStreamedFinalResponse() {
        // Arrange
        mockEventText("Hello");
        when(event.finalResponse()).thenReturn(true);
        when(context.handleDuplicateOrEmptyStream("Hello")).thenReturn(Optional.of("Hello"));

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertValueCount(3);
        testSubscriber.assertValueAt(0, v -> v instanceof TextMessageStartEvent);
        testSubscriber.assertValueAt(1, v -> v instanceof TextMessageContentEvent && ((TextMessageContentEvent)v).getDelta().equals("Hello"));
        testSubscriber.assertValueAt(2, v -> v instanceof TextMessageEndEvent);
        testSubscriber.assertComplete();
    }
    
    @Test
    void shouldEmitStartContentEndInSequence_whenStreamedMessageReceived() {
        // Arrange - Part 1: Start of stream
        String messageId = "stream-msg-123";
        mockEventText("Hello ");
        when(event.finalResponse()).thenReturn(false);
        when(context.startStreamingIfNeeded()).thenReturn(Optional.of(messageId));
        when(context.getStreamingMessageId()).thenReturn(Optional.of(messageId));
        when(context.isStreaming()).thenReturn(false).thenReturn(true); // Is not streaming before, is streaming after

        // Act 1
        TestSubscriber<BaseEvent> subscriber1 = translationStep.translate(event, context).test();

        // Assert 1
        subscriber1.assertValueCount(2);
        subscriber1.assertValueAt(0, v -> v instanceof TextMessageStartEvent);
        subscriber1.assertValueAt(1, v -> v instanceof TextMessageContentEvent && ((TextMessageContentEvent)v).getDelta().equals("Hello "));
        subscriber1.assertComplete();

        // Arrange - Part 2: Middle of stream
        mockEventText("world!");
        when(context.startStreamingIfNeeded()).thenReturn(Optional.empty()); // Already streaming

        // Act 2
        TestSubscriber<BaseEvent> subscriber2 = translationStep.translate(event, context).test();

        // Assert 2
        subscriber2.assertValueCount(1);
        subscriber2.assertValueAt(0, v -> v instanceof TextMessageContentEvent && ((TextMessageContentEvent)v).getDelta().equals("world!"));
        subscriber2.assertComplete();

        // Arrange - Part 3: End of stream
        mockEventText(""); // Final response can have no text
        when(event.finalResponse()).thenReturn(true);
        when(context.forceCloseStreamingMessage()).thenReturn(Optional.of(messageId));
        when(context.handleDuplicateOrEmptyStream(anyString())).thenReturn(Optional.empty()); // Assume it's a duplicate or empty

        // Act 3
        TestSubscriber<BaseEvent> subscriber3 = translationStep.translate(event, context).test();

        // Assert 3
        subscriber3.assertValueCount(1);
        subscriber3.assertValueAt(0, v -> v instanceof TextMessageEndEvent);
        subscriber3.assertComplete();
    }
    
    @Test
    void shouldReturnEmpty_whenDuplicateFinalResponseReceived() {
        // Arrange
        String duplicateText = "This is a duplicate message.";
        mockEventText(duplicateText);
        when(event.finalResponse()).thenReturn(true);
        // Simulate the context identifying this as a duplicate stream
        when(context.handleDuplicateOrEmptyStream(duplicateText)).thenReturn(Optional.empty());

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }
    
    // More tests to be added
}

